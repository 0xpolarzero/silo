use serde_json::Value;

#[test]
fn material_preview_theme_command_is_not_granted_to_production_windows() {
    let manifests: Value =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: Value =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    assert_eq!(
        manifests["__app-acl__"]["permissions"]["allow-set-preview-theme"]["commands"]["allow"],
        serde_json::json!(["set_preview_theme"]),
    );
    for capability in capabilities.as_object().unwrap().values() {
        assert!(
            !capability["permissions"].as_array().unwrap()
                .contains(&Value::String("allow-set-preview-theme".into())),
            "Only the example harness can grant its theme command at runtime",
        );
    }
}

#[test]
fn migration_and_checkpoint_commands_are_allowlisted_for_the_main_window() {
    let manifests: Value =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: Value =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    let preview = &capabilities["preview"];
    assert_eq!(preview["windows"], serde_json::json!(["main"]));
    assert_eq!(preview["local"], serde_json::json!(true));

    for command in [
        "read_runtime_migration_state",
        "retry_runtime_migration",
        "continue_after_migration_failure",
        "create_checkpoint",
        "fork_checkpoint",
        "restore_checkpoint",
        "delete_checkpoint",
        "read_checkpoint_usage",
        "remote_checkpoint_action",
    ] {
        let permission = format!("allow-{}", command.replace('_', "-"));
        assert_eq!(
            manifests["__app-acl__"]["permissions"][&permission]["commands"]["allow"],
            serde_json::json!([command]),
            "Tauri must generate a permission for {command}"
        );
        assert!(
            preview["permissions"]
                .as_array()
                .unwrap()
                .contains(&Value::String(permission.clone())),
            "The local main window must be able to invoke {command}"
        );
    }
}

#[test]
fn reveal_backup_archive_is_allowlisted_for_the_main_window_only() {
    let manifests: Value =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: Value =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    let preview = &capabilities["preview"];
    assert_eq!(preview["windows"], serde_json::json!(["main"]));
    assert_eq!(preview["local"], serde_json::json!(true));

    assert_eq!(
        manifests["__app-acl__"]["permissions"]["allow-reveal-backup-archive"]["commands"]
            ["allow"],
        serde_json::json!(["reveal_backup_archive"]),
        "Tauri must generate a permission for reveal_backup_archive"
    );
    assert!(
        preview["permissions"]
            .as_array()
            .unwrap()
            .contains(&Value::String("allow-reveal-backup-archive".into())),
        "The local main window must be able to invoke reveal_backup_archive"
    );

    // No other capability may grant the command to a non-main window.
    for (name, capability) in capabilities.as_object().unwrap() {
        if name == "preview" {
            continue;
        }
        assert!(
            !capability["permissions"]
                .as_array()
                .unwrap()
                .contains(&Value::String("allow-reveal-backup-archive".into())),
            "Only the main window may reveal export files, not {name}"
        );
    }
}
