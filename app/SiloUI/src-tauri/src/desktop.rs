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

// Stage the bundled sources for first installation and explicit repairs/updates.
// An existing guest helper may predate these pinned inputs, so never delegate
// installation or repair to an older copy.
fn installer_script(action: &str) -> String {
    let mut script = String::from("set -eu\ndesktop_stage=$(mktemp -d /tmp/silo-desktop.XXXXXXXX)\ntrap 'rm -rf \"$desktop_stage\"' EXIT\n");
    for (variable, filename, source, delimiter) in [
        (
            "SILO_DESKTOP_SERVICE_SOURCE",
            "desktop-service.py",
            include_str!("../guest/desktop-service.py"),
            "SILO_DESKTOP_SERVICE_EOF",
        ),
        (
            "SILO_DESKTOP_STREAMER_LOCK_SOURCE",
            "desktop-streamer-lock.json",
            include_str!("../guest/desktop-streamer-lock.json"),
            "SILO_DESKTOP_STREAMER_LOCK_EOF",
        ),
        (
            "SILO_SELKIES_WEB_CLIENT_PATCH_SOURCE",
            "patch-selkies-web-client.py",
            include_str!("../guest/patch-selkies-web-client.py"),
            "SILO_SELKIES_WEB_CLIENT_PATCH_EOF",
        ),
    ] {
        script.push_str(&format!("export {variable}=\"$desktop_stage/{filename}\"\ncat > \"${variable}\" <<'{delimiter}'\n{source}\n{delimiter}\n"));
    }
    script.push_str(&format!("set -- {action}\n(\n"));
    script.push_str(include_str!("../guest/setup-desktop.sh"));
    script.push_str("\n)\n");
    script
}

fn lcu_setup_script() -> String {
    let mut script = String::from(
        "set -eu\nlcu_stage=$(mktemp -d /tmp/silo-lcu.XXXXXXXX)\ntrap 'rm -rf \"$lcu_stage\"' EXIT\n",
    );
    for (filename, source, delimiter) in [
        (
            "setup-lcu.py",
            include_str!("../guest/setup-lcu.py"),
            "SILO_LCU_SETUP_EOF",
        ),
        (
            "lcu-lock.json",
            include_str!("../guest/lcu-lock.json"),
            "SILO_LCU_LOCK_EOF",
        ),
    ] {
        script.push_str(&format!(
            "cat > \"$lcu_stage/{filename}\" <<'{delimiter}'\n{source}\n{delimiter}\n"
        ));
    }
    script.push_str(
        r#"lcu_status=$(python3 "$lcu_stage/setup-lcu.py" status)
if printf '%s\n' "$lcu_status" | python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("status") == "needs-runtime" else 1)'; then printf '%s\n' "$lcu_status"; exit 0; fi
install -d -m 0755 /usr/local/libexec /usr/local/share/silo
install -m 0755 "$lcu_stage/setup-lcu.py" /usr/local/libexec/silo-setup-lcu.py
install -m 0644 "$lcu_stage/lcu-lock.json" /usr/local/share/silo/lcu-lock.json
python3 /usr/local/libexec/silo-setup-lcu.py setup
"#,
    );
    script
}

fn action_script(action: &str) -> String {
    if action == "setup-lcu" {
        lcu_setup_script()
    } else if action == "update-streamer" {
        installer_script(action)
    } else {
        format!("/usr/local/bin/silo-desktop {action}")
    }
}

fn action_timeout(action: &str) -> Duration {
    if matches!(action, "update-streamer" | "setup-lcu") {
        Duration::from_secs(1800)
    } else if action == "restart-streamer" {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(60)
    }
}

/// How long the operation queue should treat a desktop action as healthy: the
/// guest command's own limit plus time to start the VM (G-14).
fn action_expected_duration(action: &str) -> Duration {
    (action_timeout(action) + Duration::from_secs(5 * 60)).max(Duration::from_secs(10 * 60))
}

fn action_starts_vm(action: &str) -> bool {
    action == "start"
}

pub(crate) fn configure_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    previous: Option<&DesktopConfiguration>,
    desired: &DesktopConfiguration,
) -> Result<(), RuntimeError> {
    let inspected = runtime::inspect_workspace(runner, paths, name)?;
    runtime::ensure_managed(&inspected)?;
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
        script.push_str(&installer_script("install"));
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
    let fallback = |state: &str| json!({"installed": settings.is_some(), "state":state, "autoStart":settings.is_some_and(|s| s.start_with_sandbox), "backend":null, "sessionState":"stopped", "streamState":"stopped", "updateRequired":false, "streamerVersion":null, "lcuState":null, "lcuReason":null, "lcuVersion":null, "lcuAppVersion":null, "lcuRuntimeVersion":null, "lcuAgents":null, "lcuReadiness":null});
    let inspected =
        match runtime::observe_vm(runner, paths, machine.name()).map_err(|e| e.to_string())? {
            runtime::VmRuntime::Present(inspected) => Some(inspected),
            runtime::VmRuntime::Absent => None,
        };
    if inspected
        .as_ref()
        .is_none_or(|inspected| inspected.status != "Running")
    {
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
    let legacy_component_state = || {
        value["state"]
            .as_str()
            .filter(|state| matches!(*state, "running" | "starting" | "stopped" | "failed"))
    };
    let backend = match value.get("backend") {
        None if installed => Some("kasm"),
        None => None,
        Some(Value::Null) => None,
        Some(Value::String(backend)) if matches!(backend.as_str(), "kasm" | "selkies") => {
            Some(backend.as_str())
        }
        Some(_) => return Err("The desktop returned an invalid streamer backend.".into()),
    };
    let component_state = |field: &str| -> Result<Option<&str>, String> {
        match value.get(field) {
            None => Ok(legacy_component_state()),
            Some(Value::Null) => Ok(None),
            Some(Value::String(state))
                if matches!(
                    state.as_str(),
                    "stopped" | "starting" | "running" | "failed"
                ) =>
            {
                Ok(Some(state.as_str()))
            }
            Some(_) => Err("The desktop returned an invalid component state.".into()),
        }
    };
    let session_state = component_state("sessionState")?;
    let stream_state = component_state("streamState")?;
    let update_required = match value.get("updateRequired") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("The desktop returned an invalid update requirement.".into()),
    };
    let streamer_version = value["streamerVersion"].as_str().filter(|version| {
        let parts = version.split('.').collect::<Vec<_>>();
        parts.len() == 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    });
    let lcu_state = value["lcuState"].as_str().filter(|state| {
        matches!(
            *state,
            "needs-runtime"
                | "not-installed"
                | "repair-required"
                | "failed"
                | "installing"
                | "ready"
        )
    });
    let lcu_reason = value["lcuReason"].as_str().filter(|reason| {
        matches!(
            *reason,
            "chatgpt-app-required"
                | "invalid-receipt"
                | "unsupported-receipt"
                | "managed-runtime-missing"
                | "setup-failed"
        )
    });
    let lcu_version = safe_version(value["lcuVersion"].as_str());
    let lcu_app_version = safe_version(value["lcuAppVersion"].as_str());
    let lcu_runtime_version = safe_lcu_runtime_version(value["lcuRuntimeVersion"].as_str());
    let lcu_agents = value["lcuAgents"].as_array().map(|agents| {
        agents
            .iter()
            .filter_map(Value::as_str)
            .filter(|agent| matches!(*agent, "pi" | "codex" | "claude-code"))
            .collect::<Vec<_>>()
    });
    let lcu_readiness = value["lcuReadiness"]
        .as_str()
        .filter(|readiness| matches!(*readiness, "ready" | "unverified" | "failed"));
    Ok(
        json!({"installed":installed,"state":state,"autoStart":auto_start,
        "version":safe_version(value["version"].as_str()),"user":safe_user(value["user"].as_str()),
        "display":safe_display(value["display"].as_str()),
        "lcuState":lcu_state,
        "lcuReason":lcu_reason, "lcuVersion":lcu_version,
        "lcuAppVersion":lcu_app_version, "lcuRuntimeVersion":lcu_runtime_version,
        "lcuAgents":lcu_agents, "lcuReadiness":lcu_readiness, "backend":backend,
        "sessionState":session_state, "streamState":stream_state,
        "updateRequired":update_required, "streamerVersion":streamer_version}),
    )
}

/// A POSIX account name as the guest reports it; anything else is dropped.
fn safe_user(value: Option<&str>) -> Option<&str> {
    value.filter(|user| {
        let mut bytes = user.bytes();
        bytes
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first == b'_')
            && user.len() <= 32
            && bytes.all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte)
            })
    })
}

/// An X display such as `:1` or `:1.0`.
fn safe_display(value: Option<&str>) -> Option<&str> {
    value.filter(|display| {
        display.len() <= 32
            && display.len() > 1
            && display.starts_with(':')
            && display[1..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
    })
}

fn safe_version(value: Option<&str>) -> Option<&str> {
    value.filter(|version| {
        !version.is_empty()
            && version.len() <= 64
            && version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".+~:-_".contains(&byte))
    })
}

fn safe_lcu_runtime_version(value: Option<&str>) -> Option<&str> {
    value.filter(|runtime| {
        if runtime.len() > 64 {
            return false;
        }
        let Some((version, build)) = runtime.split_once('/') else {
            return false;
        };
        let components = version.split('.').collect::<Vec<_>>();
        let build = build.as_bytes();
        components.len() == 3
            && components.iter().all(|component| {
                !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
            })
            && build.len() == 27
            && build[..14].iter().all(u8::is_ascii_digit)
            && build[14] == b'-'
            && build[15..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    })
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
    // A desktop action changes only this VM's guest (and may start the VM); it
    // waits its turn per VM. Reading desktop status observes only, so it takes
    // no gate and stays available during other operations.
    let _guard = match action {
        Some(action) => {
            let paths = runtime::runtime_paths(app)?;
            let vm_id = runtime::resolve_vm_id(&paths, workspace).map_err(|e| e.to_string())?;
            let guard = runtime::OPERATIONS
                .vm(&vm_id, workspace, &format!("Updating {workspace} desktop"))
                .map_err(|e| e.to_string())?;
            // Desktop/guest setup is cancellable; installs legitimately run up
            // to their guest timeout, so only flag them after that.
            guard.allow_cancel();
            guard.expect_within(action_expected_duration(action));
            Some(guard)
        }
        None => None,
    };
    let (paths, machine) = machine(app, workspace)?;
    if let Some(action) = action {
        runtime::shutdown::ensure_accepting_operations()?;
        if !matches!(
            action,
            "start" | "stop" | "restart" | "restart-streamer" | "update-streamer" | "setup-lcu"
        ) {
            return Err("Unsupported desktop action.".into());
        }
        if configuration(&machine).is_none() {
            return Err("Add a Linux desktop in sandbox settings first.".into());
        }
        let inspected = match runtime::observe_vm(&runtime::ProcessRunner, &paths, workspace)
            .map_err(|e| e.to_string())?
        {
            runtime::VmRuntime::Absent => return Err(crate::terminal::start_first(workspace)),
            runtime::VmRuntime::Present(inspected) => inspected,
        };
        if action_starts_vm(action) && matches!(inspected.status.as_str(), "Created" | "Stopped") {
            runtime::start_for_desktop(&paths, workspace).map_err(|e| e.to_string())?;
        } else if inspected.status != "Running" {
            return Err("Start the sandbox before changing its desktop session.".into());
        }
        guest(
            &runtime::ProcessRunner,
            &paths,
            workspace,
            &action_script(action),
            action_timeout(action),
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
    .map_err(|_| {
        "Silo could not finish the Linux desktop action. Reopen the viewer and retry.".to_string()
    })?
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
    use crate::test_support::paths;
    use crate::test_support::runner::{ExpectedCommand, ScriptedRunner};

    fn inspect(status: &str, labels: Value) -> ExpectedCommand {
        ExpectedCommand::ok(
            ["inspect", "dev", "--format", "json"],
            json!({"name":"dev","status":status,"config":{"labels":labels}}).to_string(),
        )
        .with_timeout(Duration::from_secs(10))
    }

    fn managed_vm() -> ExpectedCommand {
        inspect("Stopped", json!({"silo.managed":"true"}))
    }

    fn configure_guest(script: String) -> ExpectedCommand {
        ExpectedCommand::ok(
            [
                "exec",
                "dev",
                "--no-tty",
                "--quiet",
                "--timeout",
                "1800s",
                "--user",
                "root",
                "--workdir",
                "/",
                "--",
                "sh",
                "-c",
                &script,
            ],
            "",
        )
        .with_timeout(Duration::from_secs(1860))
    }
    #[test]
    fn install_rejects_runtime_without_boot_hook_before_mutating_guest() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let runner = ScriptedRunner::new([
            managed_vm(),
            ExpectedCommand::ok(["--silo-desktop-protocol"], "0")
                .with_timeout(Duration::from_secs(10)),
        ]);
        let error = configure_with(
            &runner,
            &paths(dir.path()),
            "dev",
            None,
            &DesktopConfiguration {
                start_with_sandbox: true,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("desktop startup"));
        runner.assert_finished();
    }

    #[test]
    fn changing_startup_policy_does_not_reinstall_or_stop_session() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let runner = ScriptedRunner::new([
            managed_vm(),
            configure_guest("/usr/local/bin/silo-desktop autostart false\n".into()),
        ]);
        configure_with(
            &runner,
            &paths(dir.path()),
            "dev",
            Some(&DesktopConfiguration {
                start_with_sandbox: true,
            }),
            &DesktopConfiguration {
                start_with_sandbox: false,
            },
        )
        .unwrap();
        runner.assert_finished();
    }
    #[test]
    fn fresh_install_stages_agent_tools_before_persisting_startup_policy() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let runner = ScriptedRunner::new([
            managed_vm(),
            ExpectedCommand::ok(["--silo-desktop-protocol"], "1")
                .with_timeout(Duration::from_secs(10)),
            configure_guest(format!(
                "{}/usr/local/bin/silo-desktop autostart false\n",
                installer_script("install")
            )),
        ]);
        configure_with(
            &runner,
            &paths(dir.path()),
            "dev",
            None,
            &DesktopConfiguration {
                start_with_sandbox: false,
            },
        )
        .unwrap();
        runner.assert_finished();
        let calls = runner.calls();
        let script = calls.last().unwrap().last().unwrap();
        assert!(!script.to_lowercase().contains("luda"));
        assert!(script.contains("SILO_DESKTOP_STREAMER_LOCK_SOURCE"));
        assert!(script.contains("desktop-streamer-lock.json"));
        assert!(script.contains("SILO_SELKIES_WEB_CLIENT_PATCH_SOURCE"));
        assert!(script.contains("patch-selkies-web-client.py"));
        assert!(script.contains("set -- install\n"));
        assert!(script.ends_with("/usr/local/bin/silo-desktop autostart false\n"));
    }

    #[test]
    fn streamer_actions_route_to_scoped_guest_commands() {
        let _test_state = crate::test_support::global_state();
        let restart = action_script("restart-streamer");
        assert_eq!(restart, "/usr/local/bin/silo-desktop restart-streamer");
        assert_eq!(action_timeout("restart-streamer"), Duration::from_secs(120));

        let update = action_script("update-streamer");
        assert!(update.contains("SILO_DESKTOP_STREAMER_LOCK_SOURCE"));
        assert!(update.contains("SILO_SELKIES_WEB_CLIENT_PATCH_SOURCE"));
        assert!(update.contains("set -- update-streamer\n"));
        assert_eq!(action_timeout("update-streamer"), Duration::from_secs(1800));
        assert_eq!(
            action_script("restart"),
            "/usr/local/bin/silo-desktop restart"
        );
    }

    #[test]
    fn lcu_setup_is_explicit_staged_and_never_starts_vm() {
        let _test_state = crate::test_support::global_state();
        let setup = action_script("setup-lcu");
        assert!(setup.contains("lcu-lock.json"));
        assert!(setup.contains("/usr/local/share/silo/lcu-lock.json"));
        assert!(setup.contains("/usr/local/libexec/silo-setup-lcu.py setup"));
        assert!(setup.contains("setup-lcu.py\" status"));
        assert!(setup.contains("needs-runtime"));
        assert!(
            setup.find("lcu_status=$(python3").unwrap() < setup.find("install -m 0644").unwrap()
        );
        assert!(!setup.contains("SILO_DESKTOP_LCU_LOCK_SOURCE"));
        assert_eq!(action_timeout("setup-lcu"), Duration::from_secs(1800));
        assert!(!action_starts_vm("setup-lcu"));
        assert!(action_starts_vm("start"));
    }

    #[test]
    fn long_desktop_actions_are_not_flagged_before_their_guest_timeout() {
        let _test_state = crate::test_support::global_state();
        for action in [
            "start",
            "stop",
            "restart",
            "restart-streamer",
            "update-streamer",
            "setup-lcu",
        ] {
            assert!(
                action_expected_duration(action) > action_timeout(action),
                "{action}"
            );
            assert!(action_expected_duration(action) >= Duration::from_secs(10 * 60));
        }
    }

    #[test]
    fn status_bounds_guest_supplied_identity_fields() {
        let _test_state = crate::test_support::global_state();
        let long = "9".repeat(65);
        let status = public_status(json!({
            "installed":true,"autoStart":false,"state":"running",
            "version":long,"user":"silo\u{1b}[31m","display":":1; echo"
        }))
        .unwrap();
        assert!(status["version"].is_null());
        assert!(status["user"].is_null());
        assert!(status["display"].is_null());
        let status = public_status(json!({
            "installed":true,"autoStart":false,"state":"running",
            "version":"1.2.3","user":"silo","display":":1.0"
        }))
        .unwrap();
        assert_eq!(status["version"], "1.2.3");
        assert_eq!(status["user"], "silo");
        assert_eq!(status["display"], ":1.0");
    }

    #[test]
    fn status_projects_only_valid_agent_tool_fields() {
        let _test_state = crate::test_support::global_state();
        // A guest that still reports Luda fields is ignored.
        let status = public_status(json!({"installed":true,"autoStart":false,"state":"stopped","ludaState":"ready","ludaVersion":"0.3.0","ludaError":"private"})).unwrap();
        assert!(status.get("ludaState").is_none());
        assert!(status.get("ludaVersion").is_none());
        assert_eq!(status["backend"], "kasm");
        assert_eq!(status["sessionState"], "stopped");
        assert_eq!(status["streamState"], "stopped");
        assert_eq!(status["updateRequired"], false);
        assert!(!status.to_string().contains("private"));
        let old =
            public_status(json!({"installed":true,"autoStart":false,"state":"stopped"})).unwrap();
        assert_eq!(old["backend"], "kasm");
        assert!(old["lcuState"].is_null());
        let split = public_status(json!({
            "installed":true,"autoStart":true,"state":"failed",
            "backend":"selkies","sessionState":"running","streamState":"failed",
            "updateRequired":true,"streamerVersion":"2.0.0","password":"private"
        }))
        .unwrap();
        assert_eq!(split["backend"], "selkies");
        assert_eq!(split["sessionState"], "running");
        assert_eq!(split["streamState"], "failed");
        assert_eq!(split["updateRequired"], true);
        assert_eq!(split["streamerVersion"], "2.0.0");
        assert!(!split.to_string().contains("private"));
        let lcu = public_status(json!({
            "installed":true,"autoStart":true,"state":"running",
            "sessionState":"running","streamState":"failed",
            "lcuState":"ready","lcuVersion":"0.4.0",
            "lcuAppVersion":"26.924.22138",
            "lcuRuntimeVersion":"0.0.24/20260924074400-f52ea85e2a98",
            "lcuAgents":["pi","codex","claude-code","unexpected"],
            "lcuReadiness":"ready","lcuReason":"invalid-receipt",
            "appPath":"/private/app","password":"private"
        }))
        .unwrap();
        assert_eq!(lcu["state"], "running");
        assert_eq!(lcu["sessionState"], "running");
        assert_eq!(lcu["streamState"], "failed");
        assert_eq!(lcu["lcuState"], "ready");
        assert_eq!(lcu["lcuAppVersion"], "26.924.22138");
        assert_eq!(
            lcu["lcuRuntimeVersion"],
            "0.0.24/20260924074400-f52ea85e2a98"
        );
        assert_eq!(lcu["lcuAgents"], json!(["pi", "codex", "claude-code"]));
        assert!(!lcu.to_string().contains("/private/app"));
        assert!(!lcu.to_string().contains("private"));
        let unsafe_runtime = public_status(json!({
            "installed":true,"autoStart":true,"state":"running",
            "lcuRuntimeVersion":"../../private/runtime"
        }))
        .unwrap();
        assert!(unsafe_runtime["lcuRuntimeVersion"].is_null());
        let prerequisite = public_status(json!({
            "installed":true,"autoStart":true,"state":"running",
            "lcuState":"needs-runtime","lcuReason":"chatgpt-app-required"
        }))
        .unwrap();
        assert_eq!(prerequisite["state"], "running");
        assert_eq!(prerequisite["lcuState"], "needs-runtime");
        assert_eq!(prerequisite["lcuReason"], "chatgpt-app-required");
    }

    #[test]
    fn stopped_status_never_boots_vm() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let runner = ScriptedRunner::new([inspect("Stopped", json!({}))]);
        let machine: MachineConfiguration = serde_json::from_value(json!({"kind":"vm","id":"id","name":"dev","cpus":1,"maxCPUs":1,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10,"desktop":{"startWithSandbox":false}})).unwrap();
        assert_eq!(
            status_with(&runner, &paths(dir.path()), &machine).unwrap(),
            json!({"installed":true,"state":"vm-stopped","autoStart":false,
                   "backend":null,"sessionState":"stopped","streamState":"stopped",
                   "updateRequired":false,"streamerVersion":null,
                   "lcuState":null,"lcuReason":null,"lcuVersion":null,
                   "lcuAppVersion":null,"lcuRuntimeVersion":null,
                   "lcuAgents":null,"lcuReadiness":null})
        );
        runner.assert_finished();
    }
    #[test]
    fn status_projection_does_not_leak_guest_credentials() {
        let _test_state = crate::test_support::global_state();
        let public = public_status(json!({"installed":true,"autoStart":true,"state":"running","password":"private","connection":{"token":"private"}})).unwrap();
        assert!(!public.to_string().contains("private"));
        assert!(
            public_status(json!({"installed":true,"autoStart":true,"state":"surprise"})).is_err()
        );
    }
}
