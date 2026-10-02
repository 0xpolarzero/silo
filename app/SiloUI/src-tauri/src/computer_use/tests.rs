use super::*;
use crate::runtime::CommandOutput;
use std::sync::Mutex as StdMutex;

const VM_ID: &str = "00000000-0000-4000-8000-000000000001";

fn machine(built_in: bool) -> MachineConfiguration {
    MachineConfiguration::Vm {
        id: VM_ID.into(),
        name: "dev".into(),
        cpus: 1,
        max_cpus: 1,
        memory_gib: 1,
        max_memory_gib: 1,
        workspace_storage_gib: 1,
        runtime_storage_gib: 1,
        desktop: Some(desktop::DesktopConfiguration {
            start_with_sandbox: true,
            built_in,
        }),
    }
}

fn paths(directory: &tempfile::TempDir) -> RuntimePaths {
    crate::test_support::paths(directory.path())
}

/// Records commands and answers every guest `exec` with `stdout`.
struct Recorder {
    calls: StdMutex<Vec<Vec<String>>>,
    stdout: String,
}

impl Recorder {
    fn new(stdout: &str) -> Self {
        Self {
            calls: StdMutex::new(Vec::new()),
            stdout: stdout.into(),
        }
    }

    fn scripts(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|args| args.last().unwrap().clone())
            .collect()
    }
}

impl RuntimeRunner for Recorder {
    fn run(
        &self,
        _paths: &RuntimePaths,
        args: &[String],
        _timeout: Duration,
    ) -> Result<CommandOutput, RuntimeError> {
        self.calls.lock().unwrap().push(args.to_vec());
        Ok(CommandOutput {
            stdout: self.stdout.clone(),
            stderr: String::new(),
        })
    }
}

fn with_published<T>(work: impl FnOnce(&Path) -> T) -> T {
    let directory = tempfile::tempdir().unwrap();
    set_test_published_dir(Some(directory.path().to_path_buf()));
    let result = work(directory.path());
    set_test_published_dir(None);
    result
}

// ---------------------------------------------------------------- mount

#[test]
fn only_built_in_vms_get_the_mount_and_it_is_read_only() {
    with_published(|dir| {
        assert_eq!(mount_args(&machine(false)).unwrap(), Vec::<String>::new());
        let args = mount_args(&machine(true)).unwrap();
        assert_eq!(
            args,
            ["-v", &format!("{}:/opt/silo/chatgpt:ro", dir.display())]
        );
        let ssh = MachineConfiguration::Ssh {
            id: "s".into(),
            name: "s".into(),
            host: "h".into(),
            user: "u".into(),
            port: 22,
        };
        assert!(mount_args(&ssh).unwrap().is_empty());
    });
}

#[test]
fn a_built_in_vm_without_a_shared_folder_is_an_error_not_a_silent_omission() {
    set_test_published_dir(None);
    let error = mount_args(&machine(true)).unwrap_err().to_string();
    assert!(error.contains("shared ChatGPT folder"), "{error}");
    assert!(mount_args(&machine(false)).unwrap().is_empty());
}

#[test]
fn the_mount_check_needs_a_read_only_bind_at_the_guest_path() {
    let bind = |guest: &str, readonly: bool| {
        json!({"type":"Bind","host":"/h/chatgpt/published","guest":guest,
            "options":{"readonly":readonly,"noexec":false}})
    };
    let workspace = json!({"type":"Owned","guest":"/workspace",
        "storage":{"kind":"disk","capacity_mib":1024}});
    let config = |mounts: Value| json!({"mounts": mounts});
    let built_in = machine(true);
    assert!(mount_present(
        &config(json!([workspace, bind("/opt/silo/chatgpt", true)])),
        &built_in
    ));
    assert!(!mount_present(&config(json!([workspace])), &built_in));
    assert!(!mount_present(
        &config(json!([workspace, bind("/opt/silo/chatgpt", false)])),
        &built_in
    ));
    assert!(!mount_present(
        &config(json!([workspace, bind("/elsewhere", true)])),
        &built_in
    ));
    assert!(!mount_present(&json!({}), &built_in));
    // A VM without built-in computer use needs no mount.
    assert!(mount_present(&config(json!([workspace])), &machine(false)));
}

#[test]
fn export_drops_the_host_specific_mount_and_refuses_a_writable_one() {
    let workspace = json!({"type":"Owned","guest":"/workspace"});
    let mount = json!({"type":"Bind","host":"/h/chatgpt/published","guest":"/opt/silo/chatgpt",
        "options":{"readonly":true}});
    let mut config = json!({"mounts":[workspace.clone(), mount.clone()]});
    strip_mount_for_export(&mut config).unwrap();
    assert_eq!(config["mounts"], json!([workspace]));
    let mut writable = json!({"mounts":[{"type":"Bind","host":"/h","guest":"/opt/silo/chatgpt",
        "options":{"readonly":false}}]});
    assert!(strip_mount_for_export(&mut writable).is_err());
    // Another bind mount is not ours to remove; the export's own checks reject it.
    let mut other = json!({"mounts":[{"type":"Bind","host":"/h","guest":"/data",
        "options":{"readonly":true}}]});
    strip_mount_for_export(&mut other).unwrap();
    assert_eq!(other["mounts"].as_array().unwrap().len(), 1);
    strip_mount_for_export(&mut json!({})).unwrap();
}

// ------------------------------------------------------------- settings

#[test]
fn approval_defaults_to_ask_and_is_kept_per_vm() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Ask);
    set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Auto);
    let other = "00000000-0000-4000-8000-000000000002";
    assert_eq!(settings(&paths, other).approval, Approval::Ask);
    set_approval(&paths, VM_ID, Approval::Ask).unwrap();
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Ask);
    assert!(set_approval(&paths, "../escape", Approval::Auto).is_err());
    assert_eq!(Approval::parse("auto"), Some(Approval::Auto));
    assert_eq!(Approval::parse("yes"), None);
}

#[test]
fn a_damaged_settings_file_means_ask() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    fs::write(settings_path(&paths, VM_ID).unwrap(), b"{not json").unwrap();
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Ask);
}

#[test]
fn forks_inherit_only_the_approval_and_deleted_vms_are_forgotten() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let child = "00000000-0000-4000-8000-000000000003";
    set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    remember(
        &paths,
        VM_ID,
        Known {
            state: "ready".into(),
            app_version: Some("1".into()),
            ..Known::default()
        },
    );
    inherit_settings(&paths, VM_ID, child);
    assert_eq!(settings(&paths, child).approval, Approval::Auto);
    assert_eq!(settings(&paths, child).known, None);
    forget(&paths, VM_ID);
    assert_eq!(settings(&paths, VM_ID), Settings::default());
    assert!(settings_path(&paths, child).unwrap().exists());
}

#[test]
fn settings_serialize_with_camel_case_names() {
    let value = serde_json::to_value(Settings {
        approval: Approval::Auto,
        known: Some(Known {
            state: "ready".into(),
            app_version: Some("26.928.31416".into()),
            ..Known::default()
        }),
    })
    .unwrap();
    assert_eq!(value["approval"], "auto");
    assert_eq!(value["known"]["appVersion"], "26.928.31416");
}

// -------------------------------------------------------- pinned pair

#[test]
fn the_pinned_pair_comes_from_the_two_locks_and_agrees() {
    let lcu: Value = serde_json::from_str(LCU_LOCK).unwrap();
    assert_eq!(lcu["version"], "0.8.1");
    assert_eq!(
        lcu["assets"]["arm64"]["sha256"],
        "441649e7afe14dc948caaa5bd94034567e4404fc8c0bb6a450bd692b73161806"
    );
    assert_eq!(
        lcu["assets"]["amd64"]["sha256"],
        "8b0934f8c0c79d40a5073f180db33db8f1568af00177befa4b8da677694731bc"
    );
    for (arch, archive) in [
        (DebArch::Arm64, "lcu-0.8.1-linux-arm64.tar.gz"),
        (DebArch::Amd64, "lcu-0.8.1-linux-x64.tar.gz"),
    ] {
        let pair = pinned(arch).unwrap();
        assert_eq!(pair["lcu"]["version"], "0.8.1");
        assert_eq!(pair["lcu"]["archive"], archive);
        assert!(pair["lcu"]["url"].as_str().unwrap().ends_with(archive));
        let app = chatgpt_app::Lock::bundled().unwrap();
        assert_eq!(pair["app"]["dir"], app.directory_name(arch));
        assert_eq!(pair["app"]["version"], app.version);
    }
}

#[test]
fn the_guest_script_installs_the_helper_and_pair_before_running_the_command() {
    let pair = pinned(DebArch::Arm64).unwrap();
    let script = guest_script(&pair, &sync_command(Some(Approval::Auto), true));
    let helper_at = script.find("SILO_CU_HELPER_EOF").unwrap();
    let pinned_at = script.find("SILO_CU_PINNED_EOF").unwrap();
    let run_at = script
        .find("/usr/local/libexec/silo-computer-use sync --force --approval auto")
        .unwrap();
    assert!(helper_at < pinned_at && pinned_at < run_at);
    assert!(script.contains("#!/usr/bin/python3"));
    assert!(script.contains(&pair.to_string()));
    // Quoted delimiters keep the helper and the pair literal.
    assert!(script.contains("<<'SILO_CU_HELPER_EOF'"));
    assert!(script.contains("<<'SILO_CU_PINNED_EOF'"));
    assert_eq!(
        sync_command(None, false),
        "/usr/local/libexec/silo-computer-use sync"
    );
}

// ----------------------------------------------------- guest commands

#[test]
fn after_boot_pushes_and_detaches_the_sync_with_the_vms_approval() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let request = runtime::MachineConfigurationRequest {
        schema_version: 1,
        machines: vec![machine(true)],
    };
    runtime::write_metadata(&paths.metadata, &request).unwrap();
    set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    let runner = Recorder::new("");
    after_boot(&runner, &paths, "dev");
    let calls = runner.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(&calls[0][..3], ["exec", "dev", "--no-start"]);
    assert!(calls[0].contains(&"--no-start".to_owned()));
    let script = calls[0].last().unwrap();
    assert!(script.contains("( setsid /usr/local/libexec/silo-computer-use sync --boot --approval auto >/dev/null 2>&1 </dev/null & )"));
}

#[test]
fn after_boot_does_nothing_for_vms_without_built_in_computer_use() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let request = runtime::MachineConfigurationRequest {
        schema_version: 1,
        machines: vec![machine(false)],
    };
    runtime::write_metadata(&paths.metadata, &request).unwrap();
    let runner = Recorder::new("");
    after_boot(&runner, &paths, "dev");
    after_boot(&runner, &paths, "unknown");
    assert!(runner.calls.lock().unwrap().is_empty());
}

#[test]
fn a_boot_that_cannot_start_computer_use_still_succeeds() {
    struct Failing;
    impl RuntimeRunner for Failing {
        fn run(
            &self,
            _: &RuntimePaths,
            _: &[String],
            _: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            Err(RuntimeError::Unavailable("guest unreachable".into()))
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let request = runtime::MachineConfigurationRequest {
        schema_version: 1,
        machines: vec![machine(true)],
    };
    runtime::write_metadata(&paths.metadata, &request).unwrap();
    after_boot(&Failing, &paths, "dev");
}

#[test]
fn changing_the_approval_of_a_running_vm_applies_it_in_the_guest() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let runner = Recorder::new("{\"state\":\"ready\",\"approval\":\"auto\"}\n");
    apply_approval_with(&runner, &paths, &machine(true), Approval::Auto, true).unwrap();
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Auto);
    let scripts = runner.scripts();
    assert_eq!(scripts.len(), 1);
    assert!(scripts[0].contains("silo-computer-use sync --approval auto\n"));
    assert!(!scripts[0].contains("setsid"), "waits for the result");
}

#[test]
fn changing_the_approval_of_a_stopped_vm_only_saves_it_for_the_next_boot() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let runner = Recorder::new("");
    apply_approval_with(&runner, &paths, &machine(true), Approval::Auto, false).unwrap();
    assert!(runner.calls.lock().unwrap().is_empty());
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Auto);
}

#[test]
fn setup_reruns_with_force_and_returns_the_guest_status() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let runner = Recorder::new("noise\n{\"state\":\"ready\",\"approval\":\"ask\"}\n");
    let status = setup_with(&runner, &paths, &machine(true), true).unwrap();
    assert_eq!(status["state"], "ready");
    assert!(runner.scripts()[0].contains("silo-computer-use sync --force --approval ask\n"));
    let broken = Recorder::new("not json");
    assert!(setup_with(&broken, &paths, &machine(true), false).is_err());
}

// --------------------------------------------------------- state mapping

fn state(inputs: Inputs) -> Value {
    computer_use_state(&inputs).0
}

fn defaults() -> Settings {
    Settings::default()
}

fn ready() -> Status {
    Status::Ready {
        path: PathBuf::from("/x"),
        version: "26.928.31416".into(),
    }
}

fn guest(state: &str, reason: Option<&str>) -> Value {
    json!({"state":state,"reason":reason,"compatibility":"tested","warning":null,
        "appVersion":"26.928.31416","runtimeVersion":"0.0.27/20260927214556-b77d38801cca",
        "lcuVersion":"0.8.0","agents":["claude-code"],"mount":"ok","approval":"ask"})
}

#[test]
fn app_status_maps_to_the_computer_use_state() {
    let settings = defaults();
    let map = |app: Option<&Status>| {
        state(Inputs {
            app,
            vm_running: true,
            guest: None,
            settings: &settings,
        })
    };
    assert_eq!(map(None)["state"], "preparing");
    assert_eq!(map(Some(&Status::NotConsented))["state"], "needs-consent");
    assert_eq!(map(Some(&Status::Idle))["state"], "preparing");
    for status in [
        Status::Downloading {
            received_bytes: 1,
            total_bytes: 2,
        },
        Status::Verifying,
        Status::Extracting,
    ] {
        assert_eq!(map(Some(&status))["state"], "preparing");
    }
    let failed = map(Some(&Status::Failed {
        reason: "No space left.".into(),
        retryable: true,
    }));
    assert_eq!(
        (failed["state"].as_str(), failed["reason"].as_str()),
        (Some("failed"), Some("No space left."))
    );
    // Ready app, running VM, no helper yet.
    let waiting = map(Some(&ready()));
    assert_eq!(waiting["state"], "unavailable");
    assert!(waiting["reason"]
        .as_str()
        .unwrap()
        .contains("Set up computer use"));
}

#[test]
fn guest_status_maps_to_the_contract_fields() {
    let settings = Settings {
        approval: Approval::Auto,
        known: None,
    };
    let app = ready();
    let map = |guest: Value| {
        computer_use_state(&Inputs {
            app: Some(&app),
            vm_running: true,
            guest: Some(&guest),
            settings: &settings,
        })
    };
    let (value, remembered) = map(guest("ready", None));
    assert_eq!(
        value,
        json!({
            "state": "ready", "reason": null, "compatibility": "tested", "warning": null,
            "approval": "auto", "appVersion": "26.928.31416",
            "runtimeVersion": "0.0.27/20260927214556-b77d38801cca",
            "lcuVersion": "0.8.0", "agents": ["claude-code"],
        })
    );
    assert_eq!(remembered.unwrap().state, "ready");
    let (installing, remembered) = map(guest("installing", None));
    assert_eq!(installing["state"], "installing");
    assert!(remembered.is_none(), "transient states are not remembered");
    let (needs_app, _) = map(guest("needs-app", Some("app-missing")));
    assert_eq!(needs_app["state"], "preparing");
    let (failed, remembered) = map(guest("failed", Some("doctor-failed")));
    assert_eq!(failed["state"], "failed");
    assert!(failed["reason"]
        .as_str()
        .unwrap()
        .contains("readiness check"));
    assert_eq!(remembered.unwrap().state, "failed");
    let (not_set_up, _) = map(guest("not-set-up", Some("not-configured")));
    assert_eq!(not_set_up["state"], "unavailable");
    // An untested pair is shown with its warning, not blocked.
    let mut untested = guest("ready", None);
    untested["compatibility"] = json!("untested");
    untested["warning"] = json!("Not tested with this app.");
    let (untested, _) = map(untested);
    assert_eq!(untested["compatibility"], "untested");
    assert_eq!(untested["warning"], "Not tested with this app.");
    // An unknown compatibility value never reaches the UI.
    let mut odd = guest("ready", None);
    odd["compatibility"] = json!("surprise");
    assert_eq!(map(odd).0["compatibility"], "unknown");
}

#[test]
fn every_failure_code_has_a_message_and_mount_problems_are_explained() {
    for code in [
        "interrupted",
        "doctor-failed",
        "desktop-session-not-running",
        "timed-out",
        "lcu-archive-unavailable",
        "lcu-archive-mismatch",
        "mount-missing",
        "mount-writable",
        "command-failed",
        "anything-else",
    ] {
        assert!(!reason_text(code).is_empty(), "{code}");
    }
    assert!(reason_text("mount-missing").contains("new sandbox"));
    assert!(!reason_text("anything-else").contains("anything-else"));
}

#[test]
fn a_stopped_vm_keeps_its_approval_and_last_known_versions() {
    let app = ready();
    let settings = Settings {
        approval: Approval::Auto,
        known: Some(Known {
            state: "ready".into(),
            compatibility: Some("untested".into()),
            warning: Some("Not tested.".into()),
            app_version: Some("26.928.31416".into()),
            runtime_version: Some("0.0.27/20260927214556-b77d38801cca".into()),
            lcu_version: Some("0.8.0".into()),
            agents: Some(vec!["codex".into()]),
        }),
    };
    let (value, remembered) = computer_use_state(&Inputs {
        app: Some(&app),
        vm_running: false,
        guest: None,
        settings: &settings,
    });
    assert_eq!(value["state"], "ready");
    assert_eq!(value["approval"], "auto");
    assert_eq!(value["appVersion"], "26.928.31416");
    assert_eq!(value["lcuVersion"], "0.8.0");
    assert_eq!(value["compatibility"], "untested");
    assert_eq!(value["agents"], json!(["codex"]));
    assert!(remembered.is_none());
    // Nothing known yet: unavailable, with the approval still shown.
    let (fresh, _) = computer_use_state(&Inputs {
        app: Some(&app),
        vm_running: false,
        guest: None,
        settings: &Settings {
            approval: Approval::Auto,
            known: None,
        },
    });
    assert_eq!(fresh["state"], "unavailable");
    assert_eq!(fresh["approval"], "auto");
    // App problems still win for a stopped VM.
    let (consent, _) = computer_use_state(&Inputs {
        app: Some(&Status::NotConsented),
        vm_running: false,
        guest: None,
        settings: &settings,
    });
    assert_eq!(consent["state"], "needs-consent");
    assert_eq!(consent["approval"], "auto");
}

#[test]
fn desktop_state_is_reported_only_for_built_in_vms() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    assert!(desktop_state(&paths, &machine(false), true, None).is_none());
    let value = desktop_state(&paths, &machine(true), false, None).unwrap();
    assert_eq!(value["approval"], "ask");
    assert!(value["state"].is_string());
}

#[test]
fn a_ready_report_is_remembered_for_the_stopped_vm() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let app = ready();
    let report = guest("ready", None);
    let current = settings(&paths, VM_ID);
    let (_, remembered) = computer_use_state(&Inputs {
        app: Some(&app),
        vm_running: true,
        guest: Some(&report),
        settings: &current,
    });
    remember(&paths, VM_ID, remembered.unwrap());
    let known = settings(&paths, VM_ID).known.unwrap();
    assert_eq!(known.lcu_version.as_deref(), Some("0.8.0"));
    assert_eq!(known.agents, Some(vec!["claude-code".to_owned()]));
}
