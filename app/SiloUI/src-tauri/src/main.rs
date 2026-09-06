mod status_panel;
mod tray;

use tauri::{Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            status_panel::open_main,
            status_panel::hide_status,
            status_panel::resize_status,
            status_panel::quit_app,
            status_panel::preview_status,
            tray::update_tray
        ])
        .setup(|app| {
            status_panel::install(app.handle())?;
            tray::install(app.handle())?;
            let window = app
                .get_webview_window("main")
                .expect("main window is configured");
            #[cfg(target_os = "linux")]
            window.set_decorations(false)?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if tray::available(&handle) {
                        if let Some(window) = handle.get_webview_window("main") {
                            status_panel::report(window.hide());
                        }
                    } else {
                        handle.exit(0);
                    }
                }
            });
            window.show()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Silo Preview")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = _event
            {
                status_panel::report(status_panel::open_main(_app.clone()));
            }
        });
}
