//! Private loopback gateway: native cookie authentication, guest Basic auth,
//! bounded HTTP headers and transparent upgraded WebSocket streams.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) struct Proxy {
    pub port: u16,
    pub cookie_name: String,
    pub token: String,
    stopped: Arc<AtomicBool>,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

struct Request {
    header: String,
    body_length: u64,
    websocket: bool,
}

fn request_header(
    header: &str,
    port: u16,
    cookie_name: &str,
    token: &str,
    upstream: u16,
    authorization: &str,
) -> Result<Request, ()> {
    let mut lines = header.split("\r\n");
    let first = lines.next().ok_or(())?;
    let parts: Vec<_> = first.split(' ').collect();
    if parts.len() != 3
        || !matches!(parts[0], "GET" | "POST" | "HEAD")
        || !parts[1].starts_with('/')
        || parts[1].starts_with("//")
        || parts[2] != "HTTP/1.1"
    {
        return Err(());
    }
    let mut host = None;
    let mut authenticated = false;
    let mut websocket = false;
    let mut body_length = None;
    let mut kept = Vec::new();
    let expected_host = format!("127.0.0.1:{port}");
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(());
        }
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "host" => {
                if host.replace(value).is_some() {
                    return Err(());
                }
            }
            "cookie" => {
                authenticated |= value
                    .split(';')
                    .any(|part| part.trim() == format!("{cookie_name}={token}"));
            }
            "origin" => {
                if value != format!("http://{expected_host}") {
                    return Err(());
                }
            }
            "authorization" | "proxy-authorization" | "connection" => {}
            "transfer-encoding" | "expect" => return Err(()),
            "content-length" => {
                if body_length.is_some()
                    || value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(());
                }
                let length = value.parse::<u64>().map_err(|_| ())?;
                if length > 64 * 1024 * 1024 {
                    return Err(());
                }
                body_length = Some(length);
                kept.push(line);
            }
            "upgrade" => {
                if websocket || !value.eq_ignore_ascii_case("websocket") {
                    return Err(());
                }
                websocket = true;
                kept.push(line);
            }
            _ => kept.push(line),
        }
    }
    if host != Some(expected_host.as_str()) || !authenticated {
        return Err(());
    }
    if websocket && body_length.is_some_and(|n| n != 0) {
        return Err(());
    }
    Ok(Request { body_length: body_length.unwrap_or(0), websocket, header: format!("{first}\r\nHost: 127.0.0.1:{upstream}\r\nOrigin: http://127.0.0.1:{upstream}\r\nAuthorization: Basic {authorization}\r\nConnection: {}\r\n{}\r\n\r\n", if websocket { "Upgrade" } else { "close" }, kept.join("\r\n")) })
}
fn forward_body(
    mut from: TcpStream,
    mut to: TcpStream,
    mut remaining: u64,
    stop: Arc<AtomicBool>,
    ended: Arc<AtomicBool>,
) {
    let _ = from.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = to.set_write_timeout(Some(Duration::from_secs(5)));
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut bytes = [0; 32 * 1024];
    while remaining > 0
        && Instant::now() < deadline
        && !stop.load(Ordering::Acquire)
        && !ended.load(Ordering::Acquire)
    {
        let count = remaining.min(bytes.len() as u64) as usize;
        match from.read(&mut bytes[..count]) {
            Ok(0) => break,
            Ok(n) => {
                if to.write_all(&bytes[..n]).is_err() {
                    break;
                }
                remaining -= n as u64;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
    }
    // One authenticated HTTP request per connection; never forward pipelined bytes.
    let _ = to.shutdown(Shutdown::Write);
}
fn relay(mut from: TcpStream, mut to: TcpStream, stop: Arc<AtomicBool>, ended: Arc<AtomicBool>) {
    let _ = from.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = to.set_write_timeout(Some(Duration::from_secs(5)));
    let mut bytes = [0; 32 * 1024];
    while !stop.load(Ordering::Acquire) && !ended.load(Ordering::Acquire) {
        match from.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                if to.write_all(&bytes[..n]).is_err() {
                    break;
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
    }
    let _ = to.shutdown(Shutdown::Write);
}
fn serve(
    mut client: TcpStream,
    port: u16,
    upstream: u16,
    cookie_name: &str,
    token: &str,
    authorization: &str,
    stop: Arc<AtomicBool>,
) -> std::io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(3)))?;
    client.set_write_timeout(Some(Duration::from_secs(3)))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() >= 16 * 1024 || Instant::now() >= deadline || stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if client.read(&mut byte)? == 0 {
            return Ok(());
        }
        bytes.push(byte[0]);
    }
    let header = std::str::from_utf8(&bytes).ok().and_then(|text| {
        request_header(text, port, cookie_name, token, upstream, authorization).ok()
    });
    let Some(header) = header else {
        client.write_all(
            b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        )?;
        return Ok(());
    };
    let mut server = match TcpStream::connect_timeout(
        &format!("127.0.0.1:{upstream}").parse().unwrap(),
        Duration::from_secs(3),
    ) {
        Ok(server) => server,
        Err(_) => {
            client.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            )?;
            return Ok(());
        }
    };
    server.set_write_timeout(Some(Duration::from_secs(3)))?;
    server.write_all(header.header.as_bytes())?;
    let incoming = client.try_clone()?;
    let outgoing = server.try_clone()?;
    let ended = Arc::new(AtomicBool::new(false));
    let peer_end = ended.clone();
    let peer_stop = stop.clone();
    let writer = thread::spawn(move || {
        if header.websocket {
            relay(incoming, outgoing, peer_stop, peer_end);
        } else {
            forward_body(incoming, outgoing, header.body_length, peer_stop, peer_end);
        }
    });
    relay(server, client, stop, ended.clone());
    ended.store(true, Ordering::Release);
    let _ = writer.join();
    Ok(())
}
impl Proxy {
    pub fn start(upstream: u16, username: &str, password: &str) -> Result<Self, String> {
        if upstream == 0
            || username.contains(':')
            || username.contains(['\r', '\n'])
            || password.contains(['\r', '\n'])
        {
            return Err("Invalid desktop connection.".into());
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|_| "Could not open desktop connection.")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Could not configure desktop connection.")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Could not read desktop connection.")?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let cookie_name = format!("silo_desktop_{port}");
        let authorization = STANDARD.encode(format!("{username}:{password}"));
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stop = stopped.clone();
        let worker_token = token.clone();
        let worker_cookie = cookie_name.clone();
        let active = Arc::new(AtomicUsize::new(0));
        thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        if active.load(Ordering::Acquire) >= 48 {
                            drop(socket);
                            continue;
                        }
                        active.fetch_add(1, Ordering::AcqRel);
                        let (stop, token, cookie, auth, count) = (
                            worker_stop.clone(),
                            worker_token.clone(),
                            worker_cookie.clone(),
                            authorization.clone(),
                            active.clone(),
                        );
                        thread::spawn(move || {
                            let _ = serve(socket, port, upstream, &cookie, &token, &auth, stop);
                            count.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(30))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            port,
            cookie_name,
            token,
            stopped,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_authenticated_same_origin_requests_reach_guest() {
        let valid = "GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nCookie: session=secret\r\nOrigin: http://127.0.0.1:8000\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Basic attacker\r\n\r\n";
        let result = request_header(valid, 8000, "session", "secret", 9000, "real")
            .unwrap()
            .header;
        assert!(result.contains("Authorization: Basic real"));
        assert!(!result.contains("attacker"));
        assert!(!result.contains("secret"));
        assert!(result.contains("Connection: Upgrade"));
        for bad in [
            valid.replace("session=secret", "session=wrong"),
            valid.replace(
                "Origin: http://127.0.0.1:8000",
                "Origin: https://evil.example",
            ),
            valid.replace("Host: 127.0.0.1:8000", "Host: evil.example"),
            valid.replace("GET /websockify", "GET http://evil.example/"),
        ] {
            assert!(request_header(&bad, 8000, "session", "secret", 9000, "real").is_err());
        }
    }
    #[test]
    fn forwards_authenticated_http_and_rejects_missing_cookie() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let proxy =
            Proxy::start(upstream.local_addr().unwrap().port(), "silo", "password").unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut data = Vec::new();
            let mut byte = [0];
            while !data.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                data.push(byte[0]);
            }
            assert!(String::from_utf8(data)
                .unwrap()
                .contains("Authorization: Basic c2lsbzpwYXNzd29yZA=="));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        for authorized in [false, true] {
            let mut socket = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            write!(
                socket,
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{}\r\n",
                proxy.port,
                if authorized {
                    format!("Cookie: {}={}\r\n", proxy.cookie_name, proxy.token)
                } else {
                    String::new()
                }
            )
            .unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            assert!(response.starts_with(if authorized {
                "HTTP/1.1 200"
            } else {
                "HTTP/1.1 403"
            }));
        }
        worker.join().unwrap();
    }
    #[test]
    fn ambiguous_or_unbounded_request_bodies_are_rejected() {
        let base = "POST / HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nCookie: session=secret\r\n";
        for fields in [
            "Content-Length: 1\r\nContent-Length: 1",
            "Content-Length: -1",
            "Content-Length: +1",
            "Content-Length: 1x",
            "Content-Length: 67108865",
            "Transfer-Encoding: chunked",
            "Expect: 100-continue",
            "Upgrade: websocket\r\nContent-Length: 1",
        ] {
            assert!(
                request_header(
                    &format!("{base}{fields}\r\n\r\n"),
                    8000,
                    "session",
                    "secret",
                    9000,
                    "real"
                )
                .is_err(),
                "accepted {fields}"
            );
        }
    }
    #[test]
    fn pipelined_unauthenticated_request_never_reaches_guest() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let proxy =
            Proxy::start(upstream.local_addr().unwrap().port(), "silo", "password").unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = String::new();
            stream.read_to_string(&mut request).unwrap();
            assert!(request.ends_with("\r\n\r\nhello"));
            assert!(!request.contains("/unauthenticated"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let mut socket = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(socket,"POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {}={}\r\nContent-Length: 5\r\n\r\nhelloGET /unauthenticated HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",proxy.port,proxy.cookie_name,proxy.token,proxy.port).unwrap();
        let mut response = [0; 128];
        let count = socket.read(&mut response).unwrap();
        assert!(response[..count].starts_with(b"HTTP/1.1 200"));
        worker.join().unwrap();
    }
    #[test]
    fn websocket_streams_bidirectionally_and_closes_when_viewer_drops() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let proxy =
            Proxy::start(upstream.local_addr().unwrap().port(), "silo", "password").unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").unwrap();
            let mut ping = [0; 4];
            stream.read_exact(&mut ping).unwrap();
            assert_eq!(&ping, b"ping");
            stream.write_all(b"pong").unwrap();
            assert_eq!(stream.read(&mut byte).unwrap(), 0);
            done_tx.send(()).unwrap();
        });
        let mut socket = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(socket,"GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {}={}\r\nOrigin: http://127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",proxy.port,proxy.cookie_name,proxy.token,proxy.port).unwrap();
        let mut headers = Vec::new();
        let mut byte = [0];
        while !headers.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
        }
        assert!(headers.starts_with(b"HTTP/1.1 101"));
        socket.write_all(b"ping").unwrap();
        let mut pong = [0; 4];
        socket.read_exact(&mut pong).unwrap();
        assert_eq!(&pong, b"pong");
        drop(proxy);
        done_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        worker.join().unwrap();
    }
}
