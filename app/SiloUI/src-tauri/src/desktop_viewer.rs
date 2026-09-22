//! A privileged local shell and an unprivileged guest child webview.
use crate::{desktop_proxy::Proxy, remote, remote_access, runtime};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{TcpListener, TcpStream},
    process::{Child, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
    WebviewWindowBuilder, Window,
};

struct Tunnel(Child);
impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Viewer {
    workspace: String,
    proxy: Option<Proxy>,
    tunnel: Option<Tunnel>,
}
static VIEWERS: OnceLock<Mutex<HashMap<String, Viewer>>> = OnceLock::new();
fn viewers() -> &'static Mutex<HashMap<String, Viewer>> {
    VIEWERS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn require_workspace(window: &Window, workspace: &str) -> Result<(), String> {
    if window.label() == "main" {
        return Ok(());
    }
    if viewers()
        .lock()
        .map_err(|_| "Desktop unavailable.")?
        .get(window.label())
        .is_some_and(|v| v.workspace == workspace)
    {
        Ok(())
    } else {
        Err("This window cannot access that desktop.".into())
    }
}
pub(crate) fn local_connection(app: &AppHandle, workspace: &str) -> Result<Value, String> {
    let _guard = runtime::MUTATION_LOCK
        .try_lock()
        .map_err(|_| "A sandbox operation is in progress. Retry shortly.")?;
    runtime::shutdown::ensure_accepting_operations()?;
    let mut connection = crate::desktop::connection_local(app, workspace)?;
    let paths = runtime::runtime_paths(app)?;
    let guest = connection["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .ok_or("Invalid desktop port.")?;
    connection["port"] = json!(crate::network::desktop_endpoint(&paths, workspace, guest)?);
    Ok(connection)
}
fn connect(app: &AppHandle, workspace: &str) -> Result<(Proxy, Option<Tunnel>), String> {
    let remote_target = remote_access::target(workspace)?;
    let mut connection = if let Some((host, vm)) = &remote_target {
        remote::call_remote(app, host, "desktop.connect", json!({"vmId":vm}))?
    } else {
        local_connection(app, workspace)?
    };
    let mut upstream = connection["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .ok_or("Invalid desktop endpoint.")?;
    let mut tunnel = None;
    if let Some((host, _)) = remote_target {
        let reservation = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|_| "Could not reserve desktop connection.")?;
        let local = reservation
            .local_addr()
            .map_err(|_| "Could not read desktop connection.")?
            .port();
        let mut command = remote::ssh_tunnel_command(&host, local, upstream)?;
        drop(reservation);
        let mut child = Tunnel(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "Could not connect to the remote desktop.")?,
        );
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if child
                .0
                .try_wait()
                .map_err(|_| "Desktop tunnel failed.")?
                .is_some()
            {
                return Err("Desktop tunnel closed. Check the computer connection.".into());
            }
            if TcpStream::connect_timeout(
                &format!("127.0.0.1:{local}").parse().unwrap(),
                Duration::from_millis(150),
            )
            .is_ok()
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Desktop connection timed out. Reconnect the computer.".into());
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        tunnel = Some(child);
        upstream = local;
    }
    let username = connection["username"]
        .as_str()
        .ok_or("Missing desktop credentials.")?;
    let password = connection["password"]
        .as_str()
        .ok_or("Missing desktop credentials.")?;
    let proxy = Proxy::start(upstream, username, password)?;
    connection.take();
    Ok((proxy, tunnel))
}
#[tauri::command]
pub(crate) async fn open_desktop(
    app: AppHandle,
    window: Window,
    workspace: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Open desktops from the main Silo window.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        runtime::shutdown::ensure_accepting_operations()?;
        let name = if let Some((host, vm)) = remote_access::target(&workspace)? {
            // Verify the remote identity before creating a shell.
            let state = remote::call_remote(&app, &host, "desktop.status", json!({"vmId":vm}))?;
            let machine = state["name"].as_str().unwrap_or(&vm);
            let computer = remote::remote_host_list()?
                .into_iter()
                .find(|h| h.id == host)
                .map(|h| h.name);
            format!("{machine} · {}", computer.as_deref().unwrap_or(&host))
        } else {
            runtime::validate_name(&workspace).map_err(|e| e.to_string())?;
            let paths = runtime::runtime_paths(&app)?;
            if !runtime::read_metadata(&paths.metadata)
                .map_err(|e| e.to_string())?
                .machines
                .iter()
                .any(|m| m.is_vm() && m.name() == workspace)
            {
                return Err("Sandbox no longer exists.".into());
            }
            workspace.clone()
        };
        let mut entries = viewers().lock().map_err(|_| "Desktop unavailable.")?;
        if let Some((label, _)) = entries.iter().find(|(_, v)| v.workspace == workspace) {
            if let Some(existing) = app.get_window(label) {
                let _ = existing.show();
                return existing
                    .set_focus()
                    .map_err(|_| "Could not focus desktop.".into());
            }
        }
        if entries.len() >= 16 {
            return Err("Close an unused desktop viewer first.".into());
        }
        let label = format!("desktop-shell-{}", uuid::Uuid::new_v4().simple());
        let mut route = tauri::Url::parse("http://silo.local/index.html").unwrap();
        route
            .query_pairs_mut()
            .append_pair("desktop", &workspace)
            .append_pair("name", &name);
        let route = format!("index.html?{}", route.query().unwrap());
        entries.insert(
            label.clone(),
            Viewer {
                workspace,
                proxy: None,
                tunnel: None,
            },
        );
        drop(entries);
        let result = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(route.into()))
            .title(format!("{name} — Silo"))
            .inner_size(1200., 820.)
            .min_inner_size(640., 400.)
            .build();
        let viewer = match result {
            Ok(v) => v,
            Err(_) => {
                viewers().lock().ok().map(|mut e| e.remove(&label));
                return Err("Could not open desktop viewer.".into());
            }
        };
        viewer.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut entries) = viewers().lock() {
                    entries.remove(&label);
                }
            }
        });
        Ok(())
    })
    .await
    .map_err(|_| "Desktop window operation failed.")?
}
/// WKWebView can inset its CSS viewport below the titlebar while its native
/// frame (and Tao's content frame) still includes that area. Measure that gap.
#[cfg(any(target_os = "macos", test))]
fn viewport_inset(shell_height: u32, scale: f64, viewport_height: f64) -> Result<f64, String> {
    if !scale.is_finite() || scale <= 0. || !viewport_height.is_finite() || viewport_height <= 0. {
        return Err("Could not determine desktop viewport geometry.".into());
    }
    Ok((f64::from(shell_height) / scale - viewport_height).max(0.))
}

/// CSS bounds originate in the shell webview, while native children use the
/// window's coordinate system. Convert the native content offset exactly once.
fn desktop_position(
    shell_x: i32,
    shell_y: i32,
    scale: f64,
    css_x: f64,
    css_y: f64,
) -> Result<LogicalPosition<f64>, String> {
    if !scale.is_finite() || scale <= 0. {
        return Err("Could not determine desktop display scale.".into());
    }
    Ok(LogicalPosition::new(
        f64::from(shell_x) / scale + css_x,
        f64::from(shell_y) / scale + css_y,
    ))
}

fn viewer_url(origin: &str) -> tauri::Url {
    // Native viewers use WebKit. Its user agent can omit "Safari", bypassing
    // KasmVNC's safeguard against clipboard reads opening Paste menus on clicks.
    // Set the client option explicitly; its manual clipboard panel stays enabled.
    tauri::Url::parse(&format!("{origin}/?resize=scale&clipboard_seamless=false")).unwrap()
}

#[tauri::command]
pub(crate) async fn desktop_viewer_attach(
    app: AppHandle,
    window: Window,
    workspace: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_height: f64,
) -> Result<(), String> {
    require_workspace(&window, &workspace)?;
    if window.label() == "main"
        || [x, y, width, height, viewport_height]
            .iter()
            .any(|v| !v.is_finite())
        || x < 0.
        || y < 0.
        || width < 1.
        || height < 1.
        || width > 16384.
        || height > 16384.
        || viewport_height < 1.
        || viewport_height > 16384.
    {
        return Err("Invalid desktop viewer bounds.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let shell = app
            .get_webview(window.label())
            .ok_or("Desktop viewer closed.")?;
        let shell_origin = shell
            .position()
            .map_err(|_| "Could not locate desktop viewer.")?;
        let scale = window
            .scale_factor()
            .map_err(|_| "Could not determine desktop display scale.")?;
        #[cfg(target_os = "macos")]
        let inset_y = viewport_inset(
            shell
                .size()
                .map_err(|_| "Could not measure desktop viewer.")?
                .height,
            scale,
            viewport_height,
        )?;
        #[cfg(not(target_os = "macos"))]
        let inset_y = 0.;
        let position = desktop_position(shell_origin.x, shell_origin.y, scale, x, y + inset_y)?;
        let mut entries = viewers().lock().map_err(|_| "Desktop unavailable.")?;
        let entry = entries
            .get_mut(window.label())
            .filter(|v| v.workspace == workspace)
            .ok_or("Desktop viewer closed.")?;
        let label = format!("guest-{}", window.label());
        if let Some(view) = app.get_webview(&label) {
            if entry.proxy.is_some() {
                return view
                    .set_bounds(tauri::Rect {
                        position: position.into(),
                        size: LogicalSize::new(width, height).into(),
                    })
                    .map_err(|_| "Could not resize desktop.".into());
            }
            view.close().map_err(|_| "Could not reconnect desktop.")?;
        }
        let (proxy, tunnel) = connect(&app, &workspace)?;
        let origin = format!("http://127.0.0.1:{}", proxy.port);
        let permitted = origin.clone();
        let builder = WebviewBuilder::new(
            &label,
            WebviewUrl::External(tauri::Url::parse("about:blank").unwrap()),
        )
        .incognito(true)
        .focused(true)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |url| {
            url.as_str() == "about:blank" || url.origin().ascii_serialization() == permitted
        });
        let view = window
            .add_child(builder, position, LogicalSize::new(width, height))
            .map_err(|_| "Could not create desktop display.")?;
        let cookie =
            tauri::webview::Cookie::build((proxy.cookie_name.clone(), proxy.token.clone()))
                .domain("127.0.0.1")
                .path("/")
                .http_only(true)
                .build();
        if view.set_cookie(cookie).is_err() || view.navigate(viewer_url(&origin)).is_err() {
            let _ = view.close();
            return Err("Could not authenticate desktop viewer.".into());
        }
        view.set_focus()
            .map_err(|_| "Could not focus desktop display.")?;
        entry.proxy = Some(proxy);
        entry.tunnel = tunnel;
        Ok(())
    })
    .await
    .map_err(|_| "Desktop connection failed.")?
}
#[tauri::command]
pub(crate) async fn desktop_viewer_detach(app: AppHandle, window: Window) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = viewers().lock().map_err(|_| "Desktop unavailable.")?;
        let entry = entries
            .get_mut(window.label())
            .ok_or("Unknown desktop viewer.")?;
        if let Some(view) = app.get_webview(&format!("guest-{}", window.label())) {
            let _ = view.close();
        }
        entry.proxy = None;
        entry.tunnel = None;
        Ok(())
    })
    .await
    .map_err(|_| "Desktop disconnect failed.")?
}
pub(crate) fn close_all() {
    if let Ok(mut entries) = viewers().lock() {
        for entry in entries.values_mut() {
            entry.proxy = None;
            entry.tunnel = None;
        }
    }
}
pub(crate) fn close_host(host: &str) {
    if let Ok(mut entries) = viewers().lock() {
        for entry in entries
            .values_mut()
            .filter(|v| v.workspace.starts_with(&format!("silo-remote:{host}:")))
        {
            entry.proxy = None;
            entry.tunnel = None;
        }
    }
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    #[test]
    fn macos_css_viewport_inset_matches_live_retina_geometry_and_fullscreen() {
        let inset = viewport_inset(1640, 2., 788.).unwrap();
        assert_eq!(inset, 32.);
        assert_eq!(
            desktop_position(0, 0, 2., 0., 44. + inset).unwrap(),
            LogicalPosition::new(0., 76.)
        );
        assert_eq!(viewport_inset(1640, 2., 820.).unwrap(), 0.);
        assert_eq!(viewport_inset(1600, 2., 820.).unwrap(), 0.);
        for scale in [1., 1.5, 2., 3.] {
            assert_eq!(
                viewport_inset((820. * scale) as u32, scale, 788.).unwrap(),
                32.
            );
        }
        for invalid in [0., -1., f64::INFINITY, f64::NAN] {
            assert!(viewport_inset(1640, invalid, 788.).is_err());
            assert!(viewport_inset(1640, 2., invalid).is_err());
        }
    }

    #[test]
    fn child_position_includes_titlebar_inset_at_each_display_scale() {
        for scale in [1., 1.5, 2., 3.] {
            let offset = (28. * scale) as i32;
            let actual = desktop_position(0, offset, scale, 12., 48.).unwrap();
            assert_eq!(actual, LogicalPosition::new(12., 76.));
        }
    }

    #[test]
    fn child_position_translates_both_axes_without_scaling_css_twice() {
        assert_eq!(
            desktop_position(24, 56, 2., 8., 48.).unwrap(),
            LogicalPosition::new(20., 76.)
        );
        assert_eq!(
            desktop_position(0, 0, 2., 8., 48.).unwrap(),
            LogicalPosition::new(8., 48.)
        );
        for invalid in [0., -1., f64::INFINITY, f64::NAN] {
            assert!(desktop_position(0, 0, invalid, 0., 0.).is_err());
        }
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn every_viewer_connection_disables_implicit_clipboard_reads() {
        // Local and SSH-tunneled desktops both receive a fresh loopback origin.
        for port in [42001, 53102] {
            let origin = format!("http://127.0.0.1:{port}");
            let url = viewer_url(&origin);
            assert_eq!(url.origin().ascii_serialization(), origin);
            let settings: HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(
                settings.get("clipboard_seamless").map(String::as_str),
                Some("false")
            );
            assert_eq!(settings.get("resize").map(String::as_str), Some("scale"));
            // Manual clipboard transfer keeps the client's enabled defaults.
            assert!(!settings.contains_key("clipboard_up"));
            assert!(!settings.contains_key("clipboard_down"));
        }
    }
}
