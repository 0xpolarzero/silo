fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_main",
            "hide_status",
            "resize_status",
            "quit_app",
            "update_tray",
            "initialize_settings",
            "read_settings",
            "update_settings",
            "update_onboarding_draft",
            "import_legacy_theme",
            "flush_settings",
            "begin_settings_flush",
            "complete_settings_flush",
            "list_applications",
            "choose_application",
        ]),
    ))
    .expect("failed to build desktop permissions");
}
