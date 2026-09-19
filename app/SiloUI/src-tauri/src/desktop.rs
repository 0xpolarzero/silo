//! An optional guest desktop. Agent tools are independent consumers of its X session.
use crate::runtime::{self, MachineConfiguration, RuntimeError, RuntimePaths, RuntimeRunner};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopConfiguration {
    #[serde(default = "default_start")]
    pub start_with_sandbox: bool,
}
fn default_start() -> bool {
    true
}

pub(crate) fn configuration(machine: &MachineConfiguration) -> Option<&DesktopConfiguration> {
    match machine {
        MachineConfiguration::Vm { desktop, .. } => desktop.as_ref(),
        _ => None,
    }
}
pub(crate) fn only_desktop_changed(
    previous: &MachineConfiguration,
    next: &MachineConfiguration,
) -> bool {
    let mut previous = previous.clone();
    let mut next = next.clone();
    match (&mut previous, &mut next) {
        (
            MachineConfiguration::Vm { desktop: old, .. },
            MachineConfiguration::Vm { desktop: new, .. },
        ) => {
            let changed = old != new;
            *old = None;
            *new = None;
            changed && previous == next
        }
        _ => false,
    }
}

fn guest(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    script: &str,
    timeout: Duration,
    allow_boot: bool,
) -> Result<String, RuntimeError> {
    let mut args = vec![
        "exec".into(),
        name.into(),
        "--no-tty".into(),
        "--quiet".into(),
        "--timeout".into(),
        format!("{}s", timeout.as_secs()),
        "--user".into(),
        "root".into(),
        "--workdir".into(),
        "/".into(),
        "--".into(),
        "sh".into(),
        "-c".into(),
        script.into(),
    ];
    if !allow_boot {
        args.insert(2, "--no-start".into());
    }
    let output = runner.run(paths, &args, timeout + Duration::from_secs(60))?;
    Ok(output.stdout)
}

pub(crate) fn configure_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    previous: Option<&DesktopConfiguration>,
    desired: &DesktopConfiguration,
) -> Result<(), RuntimeError> {
    let mut script = String::new();
    if previous.is_none() {
        let capability = runner.run(
            paths,
            &["--silo-desktop-protocol".into()],
            Duration::from_secs(10),
        )?;
        if capability.stdout.trim() != "1" {
            return Err(RuntimeError::Unavailable("The bundled runtime does not support desktop startup. Repair or update Silo before adding a desktop.".into()));
        }
        script.push_str("set -eu\ndesktop_stage=$(mktemp -d /tmp/silo-desktop.XXXXXXXX)\ntrap 'rm -rf \"$desktop_stage\"' EXIT\nexport SILO_DESKTOP_SERVICE_SOURCE=\"$desktop_stage/desktop-service.py\"\ncat > \"$SILO_DESKTOP_SERVICE_SOURCE\" <<'SILO_DESKTOP_SERVICE_EOF'\n");
        script.push_str(include_str!("../guest/desktop-service.py"));
        script.push_str("\nSILO_DESKTOP_SERVICE_EOF\nset -- install\n");
        // The installer runs in a subshell so its exit cannot skip preference persistence.
        script.push_str("(\n");
        script.push_str(include_str!("../guest/setup-desktop.sh"));
        script.push_str("\n)\n");
    }
    script.push_str(&format!(
        "/usr/local/bin/silo-desktop autostart {}\n",
        desired.start_with_sandbox
    ));
    guest(
        runner,
        paths,
        name,
        &script,
        Duration::from_secs(1800),
        true,
    )?;
    Ok(())
}

fn machine(
    app: &AppHandle,
    workspace: &str,
) -> Result<(RuntimePaths, MachineConfiguration), String> {
    runtime::validate_name(workspace).map_err(|e| e.to_string())?;
    let paths = runtime::runtime_paths(app)?;
    let machine = runtime::read_metadata(&paths.metadata)
        .map_err(|e| e.to_string())?
        .machines
        .into_iter()
        .find(|m| m.is_vm() && m.name() == workspace)
        .ok_or("This sandbox no longer exists on this computer.")?;
    let inspected = runtime::inspect_workspace(&runtime::ProcessRunner, &paths, workspace)
        .map_err(|e| e.to_string())?;
    runtime::ensure_managed(&inspected).map_err(|e| e.to_string())?;
    if inspected.name != workspace
        || inspected
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(machine.id())
    {
        return Err("The sandbox changed identity. Refresh before accessing its desktop.".into());
    }
    Ok((paths, machine))
}

fn status_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<Value, String> {
    let settings = configuration(machine);
    let inspected =
        runtime::inspect_workspace(runner, paths, machine.name()).map_err(|e| e.to_string())?;
    let fallback = |state: &str| json!({"installed": settings.is_some(), "state":state, "autoStart":settings.is_some_and(|s| s.start_with_sandbox)});
    if inspected.status != "Running" {
        return Ok(fallback(if settings.is_some() {
            "vm-stopped"
        } else {
            "uninstalled"
        }));
    }
    let output = guest(runner, paths, machine.name(), "if [ -x /usr/local/bin/silo-desktop ]; then /usr/local/bin/silo-desktop status; else printf '%s\\n' '{\"installed\":false,\"state\":\"uninstalled\",\"autoStart\":false}'; fi", Duration::from_secs(15), false).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(output.trim())
        .map_err(|_| "The desktop returned an invalid status.")?;
    public_status(value)
}

// Project explicit public fields: credentials and arbitrary guest output never reach the UI.
fn public_status(value: Value) -> Result<Value, String> {
    let state = value["state"]
        .as_str()
        .filter(|s| {
            matches!(
                *s,
                "running" | "stopped" | "failed" | "uninstalled" | "starting"
            )
        })
        .ok_or("The desktop returned an unknown session state.")?;
    let installed = value["installed"]
        .as_bool()
        .ok_or("The desktop returned an invalid installation state.")?;
    let auto_start = value["autoStart"]
        .as_bool()
        .ok_or("The desktop returned an invalid startup preference.")?;
    Ok(
        json!({"installed":installed,"state":state,"autoStart":auto_start,
        "version":value["version"].as_str(),"user":value["user"].as_str(),"display":value["display"].as_str()}),
    )
}

pub(crate) fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    let name = runtime::remote_ops::local_vm_name(
        app,
        params["vmId"].as_str().ok_or("Missing VM identity.")?,
    )?;
    local(
        app,
        &name,
        if method == "desktop.status" {
            None
        } else {
            Some(params["action"].as_str().ok_or("Missing desktop action.")?)
        },
    )
}

fn local(app: &AppHandle, workspace: &str, action: Option<&str>) -> Result<Value, String> {
    let _guard = runtime::MUTATION_LOCK
        .try_lock()
        .map_err(|_| "Another sandbox operation is still running.")?;
    let (paths, machine) = machine(app, workspace)?;
    if let Some(action) = action {
        runtime::shutdown::ensure_accepting_operations()?;
        if !matches!(action, "start" | "stop" | "restart") {
            return Err("Unsupported desktop action.".into());
        }
        if configuration(&machine).is_none() {
            return Err("Add a Linux desktop in sandbox settings first.".into());
        }
        let inspected = runtime::inspect_workspace(&runtime::ProcessRunner, &paths, workspace)
            .map_err(|e| e.to_string())?;
        if action == "start" && matches!(inspected.status.as_str(), "Created" | "Stopped") {
            runtime::start_for_desktop(&paths, workspace).map_err(|e| e.to_string())?;
        } else if inspected.status != "Running" {
            return Err("Start the sandbox before changing its desktop session.".into());
        }
        guest(
            &runtime::ProcessRunner,
            &paths,
            workspace,
            &format!("/usr/local/bin/silo-desktop {action}"),
            Duration::from_secs(60),
            false,
        )
        .map_err(|e| e.to_string())?;
        let _ = app.emit("silo://application-state-changed", ());
    }
    status_with(&runtime::ProcessRunner, &paths, &machine)
}

async fn execute(
    app: AppHandle,
    workspace: String,
    action: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((host, vm)) = crate::remote_access::target(&workspace)? {
            crate::remote::call_remote(
                &app,
                &host,
                if action.is_some() {
                    "desktop.action"
                } else {
                    "desktop.status"
                },
                json!({"vmId":vm,"action":action}),
            )
        } else {
            local(&app, &workspace, action.as_deref())
        }
    })
    .await
    .map_err(|_| "Desktop operation worker failed.".to_string())?
}
#[tauri::command]
pub async fn read_desktop_state(
    app: AppHandle,
    window: tauri::Window,
    workspace: String,
) -> Result<Value, String> {
    crate::desktop_viewer::require_workspace(&window, &workspace)?;
    execute(app, workspace, None).await
}
#[tauri::command]
pub async fn desktop_action(
    app: AppHandle,
    window: tauri::Window,
    workspace: String,
    action: String,
) -> Result<Value, String> {
    crate::desktop_viewer::require_workspace(&window, &workspace)?;
    execute(app, workspace, Some(action)).await
}

/// Private backend-only connection material. Never register this as a UI command.
pub(crate) fn connection_local(app: &AppHandle, workspace: &str) -> Result<Value, String> {
    let (paths, machine) = machine(app, workspace)?;
    if status_with(&runtime::ProcessRunner, &paths, &machine)?["state"] != "running" {
        return Err("The desktop is not running.".into());
    }
    let output = guest(
        &runtime::ProcessRunner,
        &paths,
        workspace,
        "/usr/local/bin/silo-desktop connection",
        Duration::from_secs(15),
        false,
    )
    .map_err(|_| "Could not read desktop connection credentials.")?;
    let value: Value = serde_json::from_str(output.trim())
        .map_err(|_| "Invalid desktop connection credentials.")?;
    let username = value["username"].as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    });
    let password = value["password"]
        .as_str()
        .filter(|s| s.len() >= 32 && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_hexdigit()));
    if value["port"].as_u64() != Some(6901) || username.is_none() || password.is_none() {
        return Err("Invalid desktop connection credentials.".into());
    }
    Ok(json!({"port":6901,"username":username,"password":password}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Runner {
        calls: Mutex<Vec<Vec<String>>>,
        output: String,
    }
    impl RuntimeRunner for Runner {
        fn run(
            &self,
            _: &RuntimePaths,
            args: &[String],
            _: Duration,
        ) -> Result<runtime::CommandOutput, RuntimeError> {
            self.calls.lock().unwrap().push(args.to_vec());
            Ok(runtime::CommandOutput {
                stdout: self.output.clone(),
                stderr: String::new(),
            })
        }
    }
    fn paths(dir: &tempfile::TempDir) -> RuntimePaths {
        RuntimePaths {
            guest_image: dir.path().join("image"),
            executable: dir.path().join("msb"),
            home: dir.path().join("home"),
            storage_home: None,
            library: dir.path().join("library"),
            metadata: dir.path().join("machines.json"),
            volumes: dir.path().join("volumes"),
        }
    }
    #[test]
    fn install_rejects_runtime_without_boot_hook_before_mutating_guest() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            calls: Mutex::new(Vec::new()),
            output: "0".into(),
        };
        let error = configure_with(
            &runner,
            &paths(&dir),
            "dev",
            None,
            &DesktopConfiguration {
                start_with_sandbox: true,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("desktop startup"));
        assert_eq!(
            *runner.calls.lock().unwrap(),
            vec![vec!["--silo-desktop-protocol".to_string()]]
        );
    }

    #[test]
    fn changing_startup_policy_does_not_reinstall_or_stop_session() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            calls: Mutex::new(Vec::new()),
            output: String::new(),
        };
        configure_with(
            &runner,
            &paths(&dir),
            "dev",
            Some(&DesktopConfiguration {
                start_with_sandbox: true,
            }),
            &DesktopConfiguration {
                start_with_sandbox: false,
            },
        )
        .unwrap();
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].last().unwrap(),
            "/usr/local/bin/silo-desktop autostart false\n"
        );
    }
    #[test]
    fn stopped_status_never_boots_vm() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            calls: Mutex::new(Vec::new()),
            output: json!({"name":"dev","status":"Stopped","config":{}}).to_string(),
        };
        let machine: MachineConfiguration = serde_json::from_value(json!({"kind":"vm","id":"id","name":"dev","cpus":1,"maxCPUs":1,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10,"desktop":{"startWithSandbox":false}})).unwrap();
        assert_eq!(
            status_with(&runner, &paths(&dir), &machine).unwrap(),
            json!({"installed":true,"state":"vm-stopped","autoStart":false})
        );
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0][0], "inspect");
    }
    #[test]
    fn status_projection_does_not_leak_guest_credentials() {
        let public = public_status(json!({"installed":true,"autoStart":true,"state":"running","password":"private","connection":{"token":"private"}})).unwrap();
        assert!(!public.to_string().contains("private"));
        assert!(
            public_status(json!({"installed":true,"autoStart":true,"state":"surprise"})).is_err()
        );
    }
}
