//! The supported VM working identity is the unified silo account.
use crate::runtime::{self, RuntimePaths};
use serde_json::Value;

const MIGRATION_REQUIRED: &str = "This VM uses the old account layout. Migrate it to the silo account or create a new VM before using it.";

pub(crate) const LABEL: &str = "silo.working-account";
pub(crate) const UNIFIED_LABEL: &str = "silo.working-account=1";

pub(crate) fn working_user(config: &Value) -> Result<&'static str, String> {
    let config = config
        .as_object()
        .ok_or("Invalid VM account policy metadata.")?;
    let Some(labels) = config.get("labels") else {
        return Err(MIGRATION_REQUIRED.into());
    };
    let labels = labels
        .as_object()
        .ok_or("Invalid VM account policy metadata.")?;
    match labels.get(LABEL) {
        None => Err(MIGRATION_REQUIRED.into()),
        Some(Value::String(version)) if version == "1" => Ok("silo"),
        _ => Err("Unsupported VM account policy. Update Silo before accessing this VM.".into()),
    }
}

pub(crate) fn inspect_user(paths: &RuntimePaths, name: &str) -> Result<&'static str, String> {
    let inspected = runtime::inspect_workspace(&runtime::ProcessRunner, paths, name)
        .map_err(|e| e.to_string())?;
    runtime::ensure_managed(&inspected).map_err(|e| e.to_string())?;
    let user = working_user(&inspected.config)?;
    require_runtime(paths, user)?;
    Ok(user)
}

pub(crate) fn require_runtime(paths: &RuntimePaths, user: &str) -> Result<(), String> {
    if user != "silo" {
        return Err("Unsupported VM working account.".into());
    }
    let output = runtime::run_msb(
        paths,
        &["--silo-working-account-protocol".into()],
        std::time::Duration::from_secs(10),
    )
    .map_err(|_| {
        "The bundled runtime cannot safely serve this VM's working account. Repair or update Silo."
    })?;
    if output.stdout.trim() != "1" {
        return Err("The bundled runtime cannot safely serve this VM's working account. Repair or update Silo.".into());
    }
    Ok(())
}

pub(crate) fn response_user(response: &Value) -> Result<&'static str, String> {
    match response.get("user") {
        None => Err(MIGRATION_REQUIRED.into()),
        Some(Value::String(user)) if user == "root" => Err(MIGRATION_REQUIRED.into()),
        Some(Value::String(user)) if user == "silo" => Ok("silo"),
        _ => {
            Err("Invalid VM account in connection response. Update Silo on both computers.".into())
        }
    }
}

pub(crate) fn require_client_protocol(user: &str, request: &Value) -> Result<(), String> {
    if user != "silo" { return Err(MIGRATION_REQUIRED.into()); }
    if request.get("accountProtocol").and_then(Value::as_u64) != Some(1) {
        return Err(
            "Update Silo on the connecting computer to access this VM's working account.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_runtime(path: &std::path::Path, unified: bool) {
    use std::os::unix::fs::PermissionsExt;
    let labels = if unified {
        serde_json::json!({"silo.managed":"true", LABEL:"1"})
    } else {
        serde_json::json!({"silo.managed":"true"})
    };
    let inspected = serde_json::json!({"name":"dev","status":"Running","config":{"labels":labels}});
    std::fs::write(
        path,
        format!(
            "#!/bin/sh\nif [ \"$1\" = --silo-working-account-protocol ]; then printf '1\\n'; exit; fi\n[ \"$1\" = inspect ] || exit 2\nprintf '%s\\n' '{}'\n",
            inspected
        ),
    )
    .unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn working_account_rejects_old_runtime_before_preparing_ssh() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let paths = RuntimePaths {
            executable: root.join("msb"),
            library: root.join("msb"),
            home: root.join("home"),
            storage_home: None,
            guest_image: root.join("image"),
            metadata: root.join("machines.json"),
            volumes: root.join("volumes"),
        };
        test_runtime(&paths.executable, true);
        assert_eq!(inspect_user(&paths, "dev").unwrap(), "silo");
        let script = std::fs::read_to_string(&paths.executable).unwrap();
        std::fs::write(&paths.executable, script.replace("printf '1", "printf '0")).unwrap();
        assert!(inspect_user(&paths, "dev")
            .unwrap_err()
            .contains("Repair or update Silo"));
        test_runtime(&paths.executable, false);
        let script = std::fs::read_to_string(&paths.executable).unwrap();
        std::fs::write(&paths.executable, script.replace("printf '1", "printf '0")).unwrap();
        assert!(inspect_user(&paths, "dev").unwrap_err().contains("Migrate"));
    }

    #[test]
    fn working_account_requires_the_unified_policy() {
        assert!(working_user(&json!({})).unwrap_err().contains("Migrate"));
        assert!(working_user(&json!({"labels":{}})).unwrap_err().contains("Migrate"));
        assert_eq!(
            working_user(&json!({"labels":{LABEL:"1"}})).unwrap(),
            "silo"
        );
        for value in [json!(null), json!("2"), json!(1), json!("root")] {
            assert!(working_user(&json!({"labels":{LABEL:value}})).is_err());
        }
        assert!(working_user(&json!({"labels":null})).is_err());
        for config in [json!(null), json!([]), json!("config")] {
            assert!(working_user(&config).is_err());
        }
    }
    #[test]
    fn working_account_requires_aware_remote_clients() {
        assert!(require_client_protocol("root", &json!({})).is_err());
        assert!(require_client_protocol("silo", &json!({"accountProtocol":1})).is_ok());
        for request in [
            json!({}),
            json!({"accountProtocol":null}),
            json!({"accountProtocol":2}),
            json!({"accountProtocol":"1"}),
        ] {
            assert!(require_client_protocol("silo", &request).is_err());
        }
    }
    #[test]
    fn working_account_remote_response_requires_silo() {
        assert!(response_user(&json!({})).is_err());
        assert_eq!(response_user(&json!({"user":"silo"})).unwrap(), "silo");
        assert!(response_user(&json!({"user":"root"})).is_err());
        for user in [json!(null), json!("silo;id"), json!("unknown"), json!(3)] {
            assert!(response_user(&json!({"user":user})).is_err());
        }
    }
}
