use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window is configured");
            #[cfg(target_os = "linux")]
            window.set_decorations(false)?;
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Silo Preview");
}
