fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_main",
            "hide_status",
            "resize_status",
            "quit_app",
            "update_tray",
        ]),
    ))
    .expect("failed to build desktop permissions");
}
