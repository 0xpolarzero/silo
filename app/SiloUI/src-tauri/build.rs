fn main() {
    for key in [
        "SILO_GITHUB_CLIENT_SECRET",
        "SILO_GITHUB_CLIENT_ID",
        "SILO_GITHUB_APP_SLUG",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    // objc2-user-notifications declares a normal framework dependency. The
    // app still supports macOS 10.13, so override it at the final link step and
    // guard every framework call at runtime on macOS 10.14 or newer.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,UserNotifications");
    }
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
            "read_system_integrations",
            "set_login_item",
            "request_notification_authorization",
            "open_integration_settings",
            "show_integration_error",
            "list_applications",
            "choose_application",
            "read_dependencies",
            "read_backup_state",
            "choose_backup_destination",
            "choose_backup_archive",
            "inspect_backup_archive",
            "start_backup",
            "start_restore",
            "cancel_backup_operation",
            "dismiss_backup_operation",
            "read_application_state",
            "read_machine_configuration",
            "list_workspace_directory",
            "push_repository",
            "read_secrets_state",
            "save_secret",
            "remove_secret",
            "retry_secret",
            "read_github_state",
            "connect_github",
            "disconnect_github",
            "set_github_access_enabled",
            "save_github_configuration",
            "retry_github_configuration",
            "refresh_github_repositories",
            "configure_workspace_identities",
            "verify_workspace_identities",
            "workspace_action",
            "retry_workspace_start",
            "save_machine_configuration",
            "read_setup_activity",
        ]),
    ))
    .expect("failed to build desktop permissions");
}
