//! Token-management transport. Never replays a request inside an HTTP call.
//! The policy worker retries only the latest intent after these gates allow it.
use reqwest::{
    blocking::{Client, Response},
    header::HeaderMap,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_RETRIES: u32 = 5;
const MAX_RESPONSE: u64 = 8 * 1024 * 1024;
static CLIENT: OnceLock<Client> = OnceLock::new();
static GATES: OnceLock<Mutex<Gates>> = OnceLock::new();
#[derive(Default)]
struct Gates {
    requests: HashMap<String, Failure>,
    rate_until: u64,
}
struct Failure {
    attempts: u32,
    until: Option<u64>,
    message: String,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn gates() -> &'static Mutex<Gates> {
    GATES.get_or_init(|| Mutex::new(Gates::default()))
}
fn client() -> Result<&'static Client, String> {
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Silo")
        .build()
        .map_err(|_| "Cannot initialize GitHub connection.")?;
    let _ = CLIENT.set(client);
    CLIENT
        .get()
        .ok_or_else(|| "Cannot initialize GitHub connection.".into())
}
fn key(route: &str, body: &[u8]) -> String {
    // Only hashes identify failed requests; credentials never appear in diagnostics.
    let mut hash = Sha256::new();
    hash.update(route);
    hash.update(body);
    format!("{:x}", hash.finalize())
}
fn waiting(until: u64, at: u64) -> String {
    format!(
        "GitHub access update is waiting. Retrying in {} seconds.",
        until.saturating_sub(at).max(1)
    )
}
impl Gates {
    fn restore_floor(&mut self, until: u64) {
        self.rate_until = self.rate_until.max(until);
    }
    fn next_retry(&self, at: u64) -> u64 {
        // The worker's persisted deadline already wakes due requests. An old
        // superseded key must not keep scheduling successful work forever.
        self.requests
            .values()
            .filter_map(|failure| failure.until)
            .filter(|until| *until > at)
            .min()
            .unwrap_or(0)
            .max(if self.rate_until > at {
                self.rate_until
            } else {
                0
            })
    }
    fn check(&self, key: &str, at: u64) -> Result<(), String> {
        if self.rate_until > at {
            return Err(waiting(self.rate_until, at));
        }
        if let Some(failure) = self.requests.get(key) {
            match failure.until {
                Some(until) if until > at => return Err(waiting(until, at)),
                None => return Err(failure.message.clone()),
                _ => {}
            }
        }
        Ok(())
    }
    fn fail(
        &mut self,
        key: String,
        at: u64,
        retryable: bool,
        floor: u64,
        rate: bool,
        jitter: u64,
        message: &str,
    ) -> String {
        let attempts = self
            .requests
            .get(&key)
            .map_or(1, |f| f.attempts.saturating_add(1));
        let base = if rate { 60u64 } else { 2 };
        let delay = base
            .saturating_mul(1u64 << attempts.saturating_sub(1).min(10))
            .min(900);
        let until = at
            .saturating_add(delay)
            .max(floor)
            .saturating_add(jitter % 4);
        if rate {
            self.rate_until = self.rate_until.max(until);
        }
        let retry = retryable && attempts <= MAX_RETRIES;
        let message = if retry {
            waiting(until, at)
        } else {
            format!("{message} Automatic retries stopped. Retry explicitly after checking GitHub access.")
        };
        self.requests.insert(
            key,
            Failure {
                attempts,
                until: retry.then_some(until),
                message: message.clone(),
            },
        );
        message
    }
}
/// Restore only a server-imposed shared deadline, never request credentials or
/// per-request hashes. Relaunch must not bypass GitHub's requested waiting time.
pub(crate) fn restore_retry_floor(until: u64) {
    if let Ok(mut g) = gates().lock() {
        g.restore_floor(until);
    }
}
pub(crate) fn retry_floor() -> u64 {
    gates().lock().map(|g| g.rate_until).unwrap_or(u64::MAX)
}
pub(crate) fn retry_at() -> u64 {
    gates()
        .lock()
        .map(|g| g.next_retry(now()))
        .unwrap_or(u64::MAX)
}
pub(crate) fn reset_retries() {
    // An explicit Retry cannot bypass GitHub's requested waiting period.
    if let Ok(mut g) = gates().lock() {
        g.requests.clear();
    }
}
fn preflight(key: &str) -> Result<(), String> {
    gates()
        .lock()
        .map_err(|_| "GitHub retry state is unavailable.")?
        .check(key, now())
}
fn failure(key: &str, retryable: bool, floor: u64, rate: bool, message: &str) -> String {
    let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]);
    gates()
        .lock()
        .map(|mut g| g.fail(key.into(), now(), retryable, floor, rate, jitter, message))
        .unwrap_or_else(|_| "GitHub retry state is unavailable.".into())
}
fn number(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.parse().ok()
}
fn retry_after(headers: &HeaderMap, at: u64) -> u64 {
    let value = headers.get("retry-after").and_then(|v| v.to_str().ok());
    let after = value
        .and_then(|v| {
            v.parse::<u64>()
                .ok()
                .map(|s| at.saturating_add(s))
                .or_else(|| {
                    time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc2822)
                        .ok()
                        .and_then(|t| u64::try_from(t.unix_timestamp()).ok())
                })
        })
        .unwrap_or(0);
    let reset = if number(headers, "x-ratelimit-remaining") == Some(0) {
        number(headers, "x-ratelimit-reset").unwrap_or(0)
    } else {
        0
    };
    after.max(reset)
}
fn is_rate_limit(status: u16, headers: &HeaderMap, body: &Value) -> bool {
    if status == 429 {
        return true;
    }
    if status != 403 {
        return false;
    }
    let message = body["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    number(headers, "x-ratelimit-remaining") == Some(0)
        || retry_after(headers, now()) > 0
        || body["code"] == "rate_limited"
        || message.contains("secondary rate limit")
        || message.contains("api rate limit exceeded")
        || message.contains("abuse detection")
}
fn retryable_response(status: u16, headers: &HeaderMap, body: &Value, safe: bool) -> bool {
    is_rate_limit(status, headers, body) || (status >= 500 && safe)
}
fn response(
    key: &str,
    result: Result<Response, reqwest::Error>,
    safe: bool,
    revoke: bool,
) -> Result<Value, String> {
    let response = result.map_err(|_| {
        failure(
            key,
            safe,
            0,
            false,
            "Cannot reach GitHub. The request outcome is unknown.",
        )
    })?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            failure(
                key,
                retryable_response(status, &headers, &Value::Null, safe),
                retry_after(&headers, now()),
                is_rate_limit(status, &headers, &Value::Null),
                "GitHub returned an incomplete response.",
            )
        })?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err(failure(
            key,
            false,
            0,
            false,
            "GitHub response exceeds the supported size.",
        ));
    }
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if revoke && matches!(status, 204 | 404) {
        if let Ok(mut g) = gates().lock() {
            g.requests.remove(key);
        }
        return Ok(serde_json::json!({"revoked":true}));
    }
    if (200..300).contains(&status) {
        if body.get("error").is_some() {
            return Err(failure(
                key,
                false,
                0,
                false,
                "GitHub rejected the authorization. Connect GitHub again.",
            ));
        }
        if body.is_null() {
            return Err(failure(
                key,
                safe,
                0,
                false,
                "GitHub returned an invalid response.",
            ));
        }
        if let Ok(mut g) = gates().lock() {
            g.requests.remove(key);
        }
        return Ok(body);
    }
    let floor = retry_after(&headers, now());
    let rate = is_rate_limit(status, &headers, &body);
    let retryable = retryable_response(status, &headers, &body, safe);
    let message = if rate {
        "GitHub is limiting requests."
    } else if status == 401 {
        "GitHub authorization expired or was revoked. Reconnect GitHub."
    } else if status == 403 {
        "GitHub refused this request. Check the App's repository permissions."
    } else {
        "GitHub access could not be updated."
    };
    Err(failure(key, retryable, floor, rate, message))
}
/// Only fixed GitHub destinations are accepted. Tokens never follow redirects.
pub(crate) enum Authentication {
    None,
    Bearer(String),
    App {
        client_id: String,
        client_secret: String,
    },
}
pub(crate) struct Request {
    pub method: reqwest::Method,
    pub url: String,
    pub authentication: Authentication,
    pub body: Value,
    pub safe: bool,
    pub revoke: bool,
}
pub(crate) fn send(request: Request) -> Result<Value, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|_| "Invalid GitHub destination.")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("api.github.com" | "github.com"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid GitHub destination.".into());
    }
    let mut bytes =
        serde_json::to_vec(&request.body).map_err(|_| "Cannot encode GitHub request.")?;
    let mut builder = client()?
        .request(request.method.clone(), url)
        .header("Accept", "application/json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    match request.authentication {
        Authentication::None => {}
        Authentication::Bearer(token) => {
            bytes.extend_from_slice(token.as_bytes());
            builder = builder.bearer_auth(token);
        }
        Authentication::App {
            client_id,
            client_secret,
        } => {
            bytes.extend_from_slice(client_id.as_bytes());
            bytes.push(0);
            bytes.extend_from_slice(client_secret.as_bytes());
            builder = builder.basic_auth(client_id, Some(client_secret));
        }
    }
    let key = key(&format!("{} {}", request.method, request.url), &bytes);
    preflight(&key)?;
    if !request.body.is_null() {
        builder = builder.json(&request.body);
    }
    response(&key, builder.send(), request.safe, request.revoke)
}
pub(crate) fn github(token: &str, path: &str) -> Result<Value, String> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("Invalid GitHub API path.".into());
    }
    send(Request {
        method: reqwest::Method::GET,
        url: format!("https://api.github.com{path}"),
        authentication: Authentication::Bearer(token.into()),
        body: Value::Null,
        safe: true,
        revoke: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wire_response(status: u16, body: &str, revoke: bool) -> Result<Value, String> {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let reply = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            stream.read(&mut request).unwrap();
            stream.write_all(reply.as_bytes()).unwrap();
        });
        let result = response(
            &uuid::Uuid::new_v4().to_string(),
            Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send(),
            false,
            revoke,
        );
        server.join().unwrap();
        result
    }
    #[test]
    fn real_http_oauth_errors_are_redacted_and_revocation_accepts_empty_responses() {
        let error = wire_response(
            200,
            r#"{"error":"bad_verification_code","error_description":"fixture-secret"}"#,
            false,
        )
        .unwrap_err();
        assert!(!error.contains("fixture-secret"));
        assert!(error.contains("rejected"));
        assert_eq!(wire_response(204, "", true).unwrap()["revoked"], true);
        assert_eq!(wire_response(404, "", true).unwrap()["revoked"], true);
        assert!(wire_response(204, "", false).is_err());
        assert!(wire_response(302, "", false).is_err());
        assert!(wire_response(200, "not json", false).is_err());
    }
    #[test]
    fn credential_destinations_are_fixed_before_network() {
        for url in [
            "http://api.github.com/user",
            "https://api.github.com.evil.test/user",
            "https://user@api.github.com/user",
            "https://github.com:444/user",
            "https://github.com/user#fragment",
        ] {
            let error = send(Request {
                method: reqwest::Method::POST,
                url: url.into(),
                authentication: Authentication::Bearer("fixture-secret".into()),
                body: Value::Null,
                safe: false,
                revoke: false,
            })
            .unwrap_err();
            assert_eq!(error, "Invalid GitHub destination.");
        }
    }
    #[test]
    fn expired_superseded_key_does_not_keep_scheduling_work() {
        let mut g = Gates::default();
        g.fail("obsolete".into(), 100, true, 0, false, 0, "offline");
        g.fail("current".into(), 110, true, 0, false, 0, "offline");
        assert_eq!(g.next_retry(101), 102);
        assert_eq!(g.next_retry(102), 112);
        assert_eq!(g.next_retry(112), 0);
        // Keep attempt counts and per-key refusal; only scheduling is filtered.
        assert!(g.check("obsolete", 112).is_ok());
        assert_eq!(g.requests["obsolete"].attempts, 1);
        g.restore_floor(200);
        assert_eq!(g.next_retry(112), 200);
        assert_eq!(g.next_retry(200), 0);
    }
    #[test]
    fn restored_rate_floor_survives_relaunch_and_cannot_be_shortened() {
        let mut g = Gates::default();
        g.restore_floor(900);
        g.restore_floor(500);
        assert!(g.check("new-session-request", 899).is_err());
        assert!(g.check("new-session-request", 900).is_ok());
        assert_eq!(g.rate_until, 900);
        assert!(g.requests.is_empty());
    }
    #[test]
    fn direct_github_secondary_limits_are_distinct_from_permissions() {
        let mut headers = HeaderMap::new();
        let secondary = serde_json::json!({"message": "You have exceeded a secondary rate limit."});
        assert!(is_rate_limit(403, &headers, &secondary));
        assert!(!is_rate_limit(
            403,
            &headers,
            &serde_json::json!({"message": "Resource not accessible by integration"})
        ));
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        // An exhausted primary limit is still a limit when reset was omitted.
        assert!(is_rate_limit(403, &headers, &Value::Null));
        assert!(!is_rate_limit(401, &headers, &secondary));
    }
    #[test]
    fn upstream_body_cannot_authorize_replaying_ambiguous_writes() {
        let headers = HeaderMap::new();
        assert!(!retryable_response(502, &headers, &Value::Null, false));
        assert!(!retryable_response(
            502,
            &headers,
            &serde_json::json!({"retryable": false}),
            false
        ));
        assert!(!retryable_response(
            502,
            &headers,
            &serde_json::json!({"retryable": true}),
            false
        ));
        assert!(retryable_response(502, &headers, &Value::Null, true));
        assert!(!retryable_response(
            403,
            &headers,
            &serde_json::json!({"retryable": true}),
            false
        ));
        assert!(retryable_response(429, &headers, &Value::Null, false));
    }
    #[test]
    fn invalid_headers_do_not_classify_permissions_as_limits() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", "unknown".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "invalid".parse().unwrap());
        headers.insert("x-ratelimit-reset", "900".parse().unwrap());
        assert_eq!(retry_after(&headers, 100), 0);
        assert!(!is_rate_limit(403, &headers, &Value::Null));
    }
    #[test]
    fn repeated_limits_back_off_and_stop_after_five_retries() {
        let mut g = Gates::default();
        let mut at = 100;
        let mut delays = Vec::new();
        for _ in 0..5 {
            g.fail("scope".into(), at, true, 0, true, 0, "limit");
            let until = g.requests["scope"].until.unwrap();
            assert!(g.check("scope", until - 1).is_err());
            assert!(g.check("scope", until).is_ok());
            delays.push(until - at);
            at = until;
        }
        assert_eq!(delays, [60, 120, 240, 480, 900]);
        g.fail("scope".into(), at, true, 0, true, 0, "limit");
        assert!(g.requests["scope"].until.is_none());
        assert!(g.check("scope", u64::MAX).is_err());
    }
    #[test]
    fn server_wait_is_a_floor_and_jitter_only_extends_it() {
        let mut g = Gates::default();
        g.fail("a".into(), 100, true, 5000, true, 3, "limit");
        assert_eq!(g.requests["a"].until, Some(5003));
        assert!(g.check("other", 5002).is_err());
        // Explicit retry preserves the shared wait even after per-request reset.
        g.requests.clear();
        assert!(g.check("a", 5002).is_err());
    }
    #[test]
    fn ambiguous_mint_is_not_replayed_but_new_choice_can_proceed() {
        let mut g = Gates::default();
        g.fail("old".into(), 100, false, 0, false, 0, "unknown");
        assert!(g.check("old", u64::MAX).is_err());
        assert!(g.check("new", 100).is_ok());
    }
    #[test]
    fn retry_headers_honor_both_deadlines_and_http_date() {
        let mut h = HeaderMap::new();
        h.insert("retry-after", "120".parse().unwrap());
        h.insert("x-ratelimit-remaining", "0".parse().unwrap());
        h.insert("x-ratelimit-reset", "900".parse().unwrap());
        assert_eq!(retry_after(&h, 100), 900);
        h.remove("x-ratelimit-remaining");
        assert_eq!(retry_after(&h, 100), 220);
        h.insert(
            "retry-after",
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after(&h, 100), 1445412480);
    }
    #[test]
    fn transient_reads_back_off_without_delaying_unrelated_keys() {
        let mut g = Gates::default();
        g.fail("read".into(), 100, true, 0, false, 0, "offline");
        assert!(g.check("read", 101).is_err());
        assert!(g.check("read", 102).is_ok());
        assert!(g.check("other", 100).is_ok());
        g.fail("read".into(), 102, true, 0, false, 0, "offline");
        assert_eq!(g.requests["read"].until, Some(106));
    }
}
