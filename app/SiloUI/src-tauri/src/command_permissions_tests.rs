use serde_json::Value;

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
