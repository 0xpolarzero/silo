use super::*;
use crate::runtime::CommandOutput;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

const VM_ID: &str = "00000000-0000-4000-8000-000000000001";
const OWNER: &str = "22222222-2222-4222-8222-222222222222";

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

/// A gate of this test's own, so tests never wait for (or hold) the process-wide one.
fn test_gate() -> &'static runtime::operation_gate::OperationGate {
    Box::leak(Box::new(runtime::operation_gate::OperationGate::new()))
}

fn boot(
    runner: SharedRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Option<std::thread::JoinHandle<()>> {
    after_boot_with(test_gate(), runner, paths, name)
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
fn an_existing_but_empty_shared_folder_never_blocks_the_mount() {
    with_published(|dir| {
        assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0);
        assert_eq!(mount_args(&machine(true)).unwrap().len(), 2);
        // Still mounted unchanged once the app (or anything else) is published into it.
        std::fs::create_dir(dir.join("1.0-arm64")).unwrap();
        assert_eq!(mount_args(&machine(true)).unwrap().len(), 2);
    });
}

#[test]
fn a_missing_or_unusable_shared_folder_blocks_the_mount() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("file");
    std::fs::write(&file, b"x").unwrap();
    for bad in [directory.path().join("gone"), file] {
        set_test_published_dir(Some(bad));
        let error = mount_args(&machine(true)).unwrap_err().to_string();
        assert!(error.contains("shared ChatGPT folder"), "{error}");
        assert!(mount_args(&machine(false)).unwrap().is_empty());
    }
    set_test_published_dir(None);
}

#[test]
fn a_built_in_vm_without_a_shared_folder_is_an_error_not_a_silent_omission() {
    let _state = crate::test_support::global_state();
    reset_published_for_test();
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
    fs::write(policy_path(&paths, VM_ID).unwrap(), b"{not json").unwrap();
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
    assert!(policy_path(&paths, child).unwrap().exists());
}

#[test]
fn settings_serialize_with_camel_case_names() {
    let value = serde_json::to_value(Settings {
        approval: Approval::Auto,
        revision: 0,
        known: Some(Known {
            state: "ready".into(),
            app_version: Some("26.928.31416".into()),
            ..Known::default()
        }),
        owner: OWNER.into(),
    })
    .unwrap();
    assert_eq!(value["approval"], "auto");
    assert!(value.get("owner").is_none());
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
    let script = guest_script(
        &pair,
        &sync_command(
            Some(&SyncPolicy {
                policy: Policy {
                    approval: Approval::Auto,
                    revision: 7,
                },
                owner: OWNER.into(),
            }),
            true,
        ),
    );
    let helper_at = script.find("SILO_CU_HELPER_EOF").unwrap();
    let pinned_at = script.find("SILO_CU_PINNED_EOF").unwrap();
    let run_at = script
        .find(&format!(
            "/usr/local/libexec/silo-computer-use sync --force --approval auto --revision 7 --owner {OWNER}"
        ))
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

/// Answers `inspect` as a running VM instance and records every other command.
struct Booting {
    inner: Recorder,
    instance: StdMutex<String>,
}

impl Booting {
    fn new(instance: &str) -> Self {
        Self {
            inner: Recorder::new(""),
            instance: StdMutex::new(instance.into()),
        }
    }
}

impl RuntimeRunner for Booting {
    fn run(
        &self,
        paths: &RuntimePaths,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, RuntimeError> {
        if args.first().is_some_and(|a| a == "inspect") {
            let instance = self.instance.lock().unwrap().clone();
            return Ok(CommandOutput {
                stdout: json!({"name":"dev","status":"Running",
                    "config":{"labels":{"silo.machine-id":VM_ID}},
                    "runtime_instance_id":instance})
                .to_string(),
                stderr: String::new(),
            });
        }
        self.inner.run(paths, args, timeout)
    }
}

fn write_machines(paths: &RuntimePaths, built_in: bool) {
    let request = runtime::MachineConfigurationRequest {
        schema_version: 1,
        machines: vec![machine(built_in)],
    };
    runtime::write_metadata(&paths.metadata, &request).unwrap();
}

#[test]
fn after_boot_pushes_and_detaches_the_sync_with_the_vms_approval() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let revision = set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    let runner = Arc::new(Booting::new("one"));
    boot(runner.clone(), &paths, "dev").unwrap().join().unwrap();
    let calls = runner.inner.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(&calls[0][..3], ["exec", "dev", "--no-start"]);
    let script = calls[0].last().unwrap();
    let owner = read_owner(&paths).unwrap();
    assert!(script.contains(&format!("( setsid /usr/local/libexec/silo-computer-use sync --boot --approval auto --revision {revision} --owner {owner} >/dev/null 2>&1 </dev/null & )")));
}

#[test]
fn a_vm_booted_by_its_pending_restore_still_gets_its_sync() {
    // Imports and forks boot inside the restore, while Silo still records them as pending.
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    runtime::checkpoints::import_pending_restore(
        &paths,
        VM_ID,
        "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9",
        "silo-backup-0-330418-1790360984903",
    )
    .unwrap();
    assert!(runtime::is_pending_restore(&paths, "dev"));
    let runner = Arc::new(Booting::new("one"));
    boot(runner.clone(), &paths, "dev").unwrap().join().unwrap();
    assert_eq!(runner.inner.scripts().len(), 1);
}

#[test]
fn after_boot_stamps_an_unstamped_policy_so_an_older_guest_mode_cannot_win() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    assert_eq!(settings(&paths, VM_ID).revision, 0);
    let runner = Arc::new(Booting::new("one"));
    boot(runner.clone(), &paths, "dev").unwrap().join().unwrap();
    let stamped = settings(&paths, VM_ID);
    assert!(stamped.revision > 0);
    assert_eq!(stamped.approval, Approval::Ask);
    assert!(runner.inner.scripts()[0]
        .contains(&format!("--approval ask --revision {}", stamped.revision)));
}

#[test]
fn after_boot_does_nothing_for_vms_without_built_in_computer_use() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, false);
    let runner = Arc::new(Booting::new("one"));
    assert!(boot(runner.clone(), &paths, "dev").is_none());
    assert!(boot(runner.clone(), &paths, "unknown").is_none());
    assert!(runner.inner.calls.lock().unwrap().is_empty());
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
    write_machines(&paths, true);
    // A runtime that cannot even inspect the VM means nothing is launched.
    if let Some(handle) = boot(Arc::new(Failing), &paths, "dev") {
        handle.join().unwrap();
    }
}

/// A guest that applies `sync` like the real helper: it keeps the newest approval
/// revision, and a launcher call can be held until the test releases it.
struct SimulatedGuest {
    /// Inspections answered so far, and after how many the VM becomes another instance.
    inspects: StdMutex<(usize, Option<usize>)>,
    applied: StdMutex<(String, u64, Option<String>)>,
    launches: StdMutex<Vec<String>>,
    /// Set while the detached launcher must stall; it signals `entered` first.
    stall: StdMutex<Option<(std::sync::mpsc::Sender<()>, Arc<std::sync::Barrier>)>>,
}

impl SimulatedGuest {
    fn new() -> Self {
        Self {
            inspects: StdMutex::new((0, None)),
            applied: StdMutex::new(("ask".into(), 0, None)),
            launches: StdMutex::new(Vec::new()),
            stall: StdMutex::new(None),
        }
    }

    fn applied_mode(&self) -> (String, u64) {
        let applied = self.applied.lock().unwrap();
        (applied.0.clone(), applied.1)
    }

    fn apply(&self, script: &str) {
        // The helper's own source precedes the command; the command is the last line.
        let words: Vec<&str> = script.lines().last().unwrap().split_whitespace().collect();
        let value = |flag: &str| {
            words
                .iter()
                .position(|word| *word == flag)
                .map(|at| words[at + 1].to_owned())
        };
        let (Some(mode), Some(revision)) = (value("--approval"), value("--revision")) else {
            return;
        };
        let revision: u64 = revision.parse().unwrap();
        let owner = value("--owner");
        let mut applied = self.applied.lock().unwrap();
        // The helper's rule: a new owner replaces the record; one owner's revisions order.
        let accepted = owner != applied.2
            || revision > applied.1
            || (revision == applied.1 && (mode == applied.0 || mode == "ask"));
        if accepted {
            *applied = (mode, revision, owner);
        }
    }
}

impl RuntimeRunner for SimulatedGuest {
    fn run(
        &self,
        _paths: &RuntimePaths,
        args: &[String],
        _timeout: Duration,
    ) -> Result<CommandOutput, RuntimeError> {
        let stdout = if args.first().is_some_and(|a| a == "inspect") {
            let mut inspects = self.inspects.lock().unwrap();
            inspects.0 += 1;
            let replaced = inspects.1.is_some_and(|after| inspects.0 > after);
            json!({"name":"dev","status":"Running",
                "config":{"labels":{"silo.machine-id":VM_ID}},
                "runtime_instance_id": if replaced { "two" } else { "one" }})
            .to_string()
        } else {
            let script = args.last().unwrap();
            if script == STATUS_COMMAND {
                let applied = self.applied.lock().unwrap().clone();
                return Ok(CommandOutput {
                    stdout: json!({"state":"ready","approval":applied.0,
                        "approvalRevision":applied.1,"approvalOwner":applied.2})
                    .to_string(),
                    stderr: String::new(),
                });
            }
            if script.contains("setsid") {
                let stall = self.stall.lock().unwrap().clone();
                if let Some((entered, release)) = stall {
                    entered.send(()).unwrap();
                    release.wait();
                }
                self.launches.lock().unwrap().push(script.clone());
            }
            self.apply(script);
            "{\"state\":\"ready\"}".into()
        };
        Ok(CommandOutput {
            stdout,
            stderr: String::new(),
        })
    }
}

#[test]
fn a_boot_sync_delayed_past_an_approval_change_cannot_undo_it() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let first = set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    let guest = Arc::new(SimulatedGuest::new());
    let (entered, entered_receiver) = std::sync::mpsc::channel();
    let release = Arc::new(std::sync::Barrier::new(2));
    *guest.stall.lock().unwrap() = Some((entered, release.clone()));
    // The app-ready sync captured `auto` and is stalled on its way into the guest.
    let handle = boot(guest.clone(), &paths, "dev").unwrap();
    entered_receiver.recv().unwrap();
    // The user completes `ask` meanwhile.
    *guest.stall.lock().unwrap() = None;
    apply_approval_with(guest.as_ref(), &paths, &machine(true), Approval::Ask, true).unwrap();
    let second = settings(&paths, VM_ID).revision;
    assert!(second > first);
    assert_eq!(guest.applied_mode(), ("ask".into(), second));
    // The delayed launcher finally runs with the older mode and revision.
    release.wait();
    handle.join().unwrap();
    let launches = guest.launches.lock().unwrap().clone();
    assert!(launches[0].contains(&format!("--approval auto --revision {first}")));
    assert_eq!(guest.applied_mode(), ("ask".into(), second));
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Ask);
}

#[test]
fn a_stalled_guest_never_delays_the_boot_that_scheduled_the_sync() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let guest = Arc::new(SimulatedGuest::new());
    let (entered, entered_receiver) = std::sync::mpsc::channel();
    let release = Arc::new(std::sync::Barrier::new(2));
    *guest.stall.lock().unwrap() = Some((entered, release.clone()));
    let started = std::time::Instant::now();
    let handle = boot(guest.clone(), &paths, "dev").unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    entered_receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("the launcher reached the guest");
    // Still stalled in the guest, yet the caller already returned.
    assert!(!handle.is_finished());
    release.wait();
    handle.join().unwrap();
}

#[test]
fn a_sync_never_acts_on_a_vm_that_was_replaced_or_stopped_meanwhile() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let guest = Arc::new(SimulatedGuest::new());
    // The VM stops and starts again after the sync was scheduled: the host thread's
    // own inspection (the second) sees another instance.
    guest.inspects.lock().unwrap().1 = Some(1);
    boot(guest.clone(), &paths, "dev").unwrap().join().unwrap();
    assert!(guest.launches.lock().unwrap().is_empty());
    // A VM that is no longer running is left alone too.
    struct Stopped;
    impl RuntimeRunner for Stopped {
        fn run(
            &self,
            _: &RuntimePaths,
            args: &[String],
            _: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            assert_eq!(args[0], "inspect", "{args:?}");
            Ok(CommandOutput {
                stdout: json!({"name":"dev","status":"Stopped","config":{}}).to_string(),
                stderr: String::new(),
            })
        }
    }
    assert!(boot(Arc::new(Stopped), &paths, "dev").is_none());
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
    assert!(scripts[0].contains("silo-computer-use sync --approval auto --revision"));
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
    assert!(
        runner.scripts()[0].contains("silo-computer-use sync --force --approval ask --revision")
    );
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
            approval_failed: false,
        })
    };
    assert_eq!(map(None)["state"], "preparing");
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
    // Silo retries by itself, so a retryable failure is still "preparing".
    assert_eq!(failed["state"], "preparing");
    assert!(failed["reason"]
        .as_str()
        .unwrap()
        .starts_with("No space left."));
    let final_failure = map(Some(&Status::Failed {
        reason: "The checksum did not match.".into(),
        retryable: false,
    }));
    assert_eq!(
        (
            final_failure["state"].as_str(),
            final_failure["reason"].as_str()
        ),
        (Some("failed"), Some("The checksum did not match."))
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
        revision: 0,
        known: None,
        owner: String::new(),
    };
    let app = ready();
    let map = |mut guest: Value| {
        guest["approval"] = json!("auto");
        computer_use_state(&Inputs {
            app: Some(&app),
            vm_running: true,
            guest: Some(&guest),
            settings: &settings,
            approval_failed: false,
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
        revision: 0,
        known: Some(Known {
            state: "ready".into(),
            compatibility: Some("untested".into()),
            warning: Some("Not tested.".into()),
            app_version: Some("26.928.31416".into()),
            runtime_version: Some("0.0.27/20260927214556-b77d38801cca".into()),
            lcu_version: Some("0.8.0".into()),
            agents: Some(vec!["codex".into()]),
        }),
        owner: String::new(),
    };
    let (value, remembered) = computer_use_state(&Inputs {
        app: Some(&app),
        vm_running: false,
        guest: None,
        settings: &settings,
        approval_failed: false,
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
            revision: 0,
            known: None,
            owner: String::new(),
        },
        approval_failed: false,
    });
    assert_eq!(fresh["state"], "unavailable");
    assert_eq!(fresh["approval"], "auto");
    // App problems still win for a stopped VM.
    let (consent, _) = computer_use_state(&Inputs {
        app: Some(&Status::Failed {
            reason: "The checksum did not match.".into(),
            retryable: false,
        }),
        vm_running: false,
        guest: None,
        settings: &settings,
        approval_failed: false,
    });
    assert_eq!(consent["state"], "failed");
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
        approval_failed: false,
    });
    remember(&paths, VM_ID, remembered.unwrap());
    let known = settings(&paths, VM_ID).known.unwrap();
    assert_eq!(known.lcu_version.as_deref(), Some("0.8.0"));
    assert_eq!(known.agents, Some(vec!["claude-code".to_owned()]));
}

// ------------------------------------------- policy vs observation (races)

#[test]
fn observations_never_rewrite_the_approval_policy() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let first = set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    // A status read took its snapshot while the policy said `auto`...
    let stale = settings(&paths, VM_ID);
    assert_eq!((stale.approval, stale.revision), (Approval::Auto, first));
    // ...the user switched to `ask` before the read could save what it saw...
    let second = set_approval(&paths, VM_ID, Approval::Ask).unwrap();
    assert!(second > first);
    // ...and the late save of receipt details must not bring `auto` back.
    remember(
        &paths,
        VM_ID,
        Known {
            state: "ready".into(),
            lcu_version: Some("0.8.1".into()),
            ..Known::default()
        },
    );
    let now = settings(&paths, VM_ID);
    assert_eq!((now.approval, now.revision), (Approval::Ask, second));
    assert_eq!(now.known.unwrap().lcu_version.as_deref(), Some("0.8.1"));
    // Reporting state for a running VM saves details only too.
    let mut report = guest("ready", None);
    report["approvalRevision"] = json!(second);
    let app = ready();
    let current = settings(&paths, VM_ID);
    let (_, remembered) = computer_use_state(&Inputs {
        app: Some(&app),
        vm_running: true,
        guest: Some(&report),
        settings: &current,
        approval_failed: false,
    });
    remember(&paths, VM_ID, remembered.unwrap());
    assert_eq!(settings(&paths, VM_ID).approval, Approval::Ask);
    assert_eq!(
        read_policy(&paths, VM_ID),
        Policy {
            approval: Approval::Ask,
            revision: second
        }
    );
}

#[test]
fn concurrent_status_saves_and_approval_changes_keep_the_last_choice() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let rounds = 150;
    std::thread::scope(|scope| {
        for reader in 0..3 {
            let paths = &paths;
            scope.spawn(move || {
                for round in 0..rounds {
                    // What a state read does after seeing whatever policy was current.
                    let seen = settings(paths, VM_ID);
                    remember(
                        paths,
                        VM_ID,
                        Known {
                            state: "ready".into(),
                            app_version: Some(format!("{reader}-{round}-{:?}", seen.approval)),
                            ..Known::default()
                        },
                    );
                }
            });
        }
        let paths = &paths;
        scope.spawn(move || {
            let mut last = 0;
            for round in 0..rounds {
                let approval = if round % 2 == 0 {
                    Approval::Auto
                } else {
                    Approval::Ask
                };
                let revision = set_approval(paths, VM_ID, approval).unwrap();
                assert!(revision > last, "revisions only grow");
                last = revision;
            }
        });
    });
    // Round 149 was the last change: `ask`.
    let policy = read_policy(&paths, VM_ID);
    assert_eq!(policy.approval, Approval::Ask);
    assert!(settings(&paths, VM_ID).known.is_some());
}

#[test]
fn concurrent_approval_changes_never_lose_or_repeat_a_revision() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    let revisions = StdMutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..50 {
                    let revision = set_approval(&paths, VM_ID, Approval::Auto).unwrap();
                    revisions.lock().unwrap().push(revision);
                }
            });
        }
    });
    let mut revisions = revisions.into_inner().unwrap();
    revisions.sort_unstable();
    let before = revisions.len();
    revisions.dedup();
    assert_eq!(revisions.len(), before, "a revision was handed out twice");
    assert_eq!(
        read_policy(&paths, VM_ID).revision,
        *revisions.last().unwrap()
    );
}

#[test]
fn a_guest_behind_the_policy_is_reported_as_applying_then_failed() {
    let app = ready();
    let settings = Settings {
        approval: Approval::Ask,
        revision: 9,
        known: None,
        owner: String::new(),
    };
    let report = |approval: &str, revision: u64, failed: bool| {
        let mut guest = guest("ready", None);
        guest["approval"] = json!(approval);
        guest["approvalRevision"] = json!(revision);
        computer_use_state(&Inputs {
            app: Some(&app),
            vm_running: true,
            guest: Some(&guest),
            settings: &settings,
            approval_failed: failed,
        })
    };
    // Applied: nothing to say.
    let (value, remembered) = report("ask", 9, false);
    assert_eq!(value["state"], "ready");
    assert!(remembered.is_some());
    // The guest still runs an older choice (revision or mode): applying.
    for (mode, revision) in [("auto", 8), ("ask", 8), ("auto", 9)] {
        let (value, remembered) = report(mode, revision, false);
        assert_eq!(value["state"], "installing", "{mode} {revision}");
        assert_eq!(value["reason"], "Applying approval change…");
        assert_eq!(value["approval"], "ask", "the user's choice is shown");
        assert!(remembered.is_none(), "a lagging report is not remembered");
    }
    // The apply already failed: say so instead of waiting forever.
    let (value, _) = report("auto", 8, true);
    assert_eq!(value["state"], "failed");
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("approval change"));
}

#[test]
fn a_failed_apply_is_remembered_until_a_later_one_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    struct Down;
    impl RuntimeRunner for Down {
        fn run(
            &self,
            _: &RuntimePaths,
            _: &[String],
            _: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            Err(RuntimeError::Unavailable("guest unreachable".into()))
        }
    }
    assert!(apply_approval_with(&Down, &paths, &machine(true), Approval::Auto, true).is_err());
    // The choice is stored even though the guest could not take it yet.
    let stored = settings(&paths, VM_ID);
    assert_eq!(stored.approval, Approval::Auto);
    assert!(apply_failed(VM_ID, stored.revision));
    let runner = Recorder::new("{\"state\":\"ready\"}\n");
    setup_with(&runner, &paths, &machine(true), true).unwrap();
    assert!(!apply_failed(VM_ID, stored.revision));
}

// ------------------------------------------------- review fixes (2026-10-02)

/// A computer whose clock is far ahead of the destination's applied this revision.
const SOURCE_REVISION: u64 = 9_000_000_000_000_000;
const SOURCE_OWNER: &str = "11111111-1111-4111-8111-111111111111";

fn imported_guest(mode: &str) -> Arc<SimulatedGuest> {
    let guest = Arc::new(SimulatedGuest::new());
    *guest.applied.lock().unwrap() = (mode.into(), SOURCE_REVISION, Some(SOURCE_OWNER.into()));
    guest
}

#[test]
fn an_imported_guest_with_a_source_clock_ahead_takes_the_destinations_default_ask() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    // The source applied `auto` under a revision far above anything this clock yields.
    let guest = imported_guest("auto");
    boot(guest.clone(), &paths, "dev").unwrap().join().unwrap();
    let launches = guest.launches.lock().unwrap().clone();
    assert_eq!(launches.len(), 1);
    let stamped = settings(&paths, VM_ID);
    assert!(stamped.revision < SOURCE_REVISION);
    assert_eq!(stamped.approval, Approval::Ask);
    let applied = guest.applied.lock().unwrap().clone();
    assert_eq!(applied.0, "ask", "the destination's default won");
    assert_eq!(applied.2.as_deref(), read_owner(&paths).as_deref());
    // Retrying (a second boot, an app-ready sync) keeps it.
    boot(guest.clone(), &paths, "dev").unwrap().join().unwrap();
    assert_eq!(guest.applied_mode().0, "ask");
}

#[test]
fn a_choice_made_after_an_import_applies_despite_the_sources_higher_revision() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let guest = imported_guest("ask");
    apply_approval_with(guest.as_ref(), &paths, &machine(true), Approval::Auto, true).unwrap();
    assert_eq!(guest.applied_mode().0, "auto");
    // The same owner's later, higher revision still orders normally.
    apply_approval_with(guest.as_ref(), &paths, &machine(true), Approval::Ask, true).unwrap();
    assert_eq!(guest.applied_mode().0, "ask");
}

#[test]
fn a_guest_holding_another_computers_choice_is_reported_as_applying() {
    let app = ready();
    let settings = Settings {
        approval: Approval::Ask,
        revision: 9,
        known: None,
        owner: OWNER.into(),
    };
    let report = |owner: Option<&str>| {
        let mut guest = guest("ready", None);
        guest["approval"] = json!("ask");
        guest["approvalRevision"] = json!(SOURCE_REVISION);
        guest["approvalOwner"] = json!(owner);
        state(Inputs {
            app: Some(&app),
            vm_running: true,
            guest: Some(&guest),
            settings: &settings,
            approval_failed: false,
        })
    };
    assert_eq!(report(Some(OWNER))["state"], "ready");
    for other in [Some(SOURCE_OWNER), None] {
        let value = report(other);
        assert_eq!(value["state"], "installing", "{other:?}");
        assert_eq!(value["reason"], "Applying approval change…");
    }
}

#[test]
fn the_owner_is_stable_per_computer_and_never_a_policy_file() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    assert_eq!(read_owner(&paths), None);
    let first = owner(&paths).unwrap();
    assert_eq!(owner(&paths).unwrap(), first);
    assert_eq!(settings(&paths, VM_ID).owner, first);
    let other = tempfile::tempdir().unwrap();
    assert_ne!(owner(&self::paths(&other)).unwrap(), first);
}

/// A VM that Silo replaced (deleted and created again under the same name) while the
/// sync waited for its turn is never synced; the replacement is recognised by its
/// runtime instance, not by its name.
#[test]
fn a_vm_replaced_after_inspection_is_not_synced_once_the_sync_gets_its_turn() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let guest = Arc::new(SimulatedGuest::new());
    let gate = test_gate();
    // A delete-and-create holds the VM's turn when the sync is scheduled.
    let replacing = gate.vm(VM_ID, "dev", "Recreating dev").unwrap();
    let handle = after_boot_with(gate, guest.clone(), &paths, "dev").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!handle.is_finished(), "the sync waits for the VM's turn");
    assert!(guest.launches.lock().unwrap().is_empty());
    // The replacement is another runtime instance by the time the turn ends.
    guest.inspects.lock().unwrap().1 = Some(1);
    drop(replacing);
    handle.join().unwrap();
    assert!(guest.launches.lock().unwrap().is_empty());
    assert_eq!(
        settings(&paths, VM_ID).revision,
        0,
        "no policy was captured either"
    );
}

#[test]
fn the_launcher_runs_inside_the_vms_turn() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let guest = Arc::new(SimulatedGuest::new());
    let (entered, entered_receiver) = std::sync::mpsc::channel();
    let release = Arc::new(std::sync::Barrier::new(2));
    *guest.stall.lock().unwrap() = Some((entered, release.clone()));
    let gate = test_gate();
    let handle = after_boot_with(gate, guest.clone(), &paths, "dev").unwrap();
    entered_receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("the launcher reached the guest");
    // A delete, stop or recreate cannot start while the launcher is in the guest.
    assert_eq!(
        gate.try_vm(VM_ID, "dev", "Deleting dev").err(),
        Some(runtime::operation_gate::GateError::Busy)
    );
    release.wait();
    handle.join().unwrap();
    assert!(gate.try_vm(VM_ID, "dev", "Deleting dev").is_ok());
}

#[test]
fn an_identity_that_cannot_be_established_at_boot_is_never_synced_later() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let running = |config: Value, instance: Option<&str>| {
        let mut value = json!({"name":"dev","status":"Running","config":config});
        if let Some(instance) = instance {
            value["runtime_instance_id"] = json!(instance);
        }
        value
    };
    /// Answers `inspect` with the next prepared reply (the last one repeats).
    struct Sequence(StdMutex<Vec<Option<String>>>, Recorder);
    impl RuntimeRunner for Sequence {
        fn run(
            &self,
            paths: &RuntimePaths,
            args: &[String],
            timeout: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            if args.first().is_some_and(|a| a == "inspect") {
                let mut replies = self.0.lock().unwrap();
                let reply = if replies.len() > 1 {
                    replies.remove(0)
                } else {
                    replies[0].clone()
                };
                return reply
                    .map(|stdout| CommandOutput {
                        stdout,
                        stderr: String::new(),
                    })
                    .ok_or_else(|| RuntimeError::Unavailable("runtime busy".into()));
            }
            self.1.run(paths, args, timeout)
        }
    }
    let labelled = json!({"labels":{"silo.machine-id":VM_ID}});
    let good = running(labelled.clone(), Some("one")).to_string();
    let failing = || None;
    let cases = [
        // The first inspection failed; a later one would show a running instance.
        vec![failing(), Some(good.clone())],
        // No instance id, an unlabelled sandbox, and another VM's label.
        vec![
            Some(running(labelled.clone(), None).to_string()),
            Some(good.clone()),
        ],
        vec![
            Some(running(json!({}), Some("one")).to_string()),
            Some(good.clone()),
        ],
        vec![
            Some(
                running(
                    json!({"labels":{"silo.machine-id":"someone-else"}}),
                    Some("one"),
                )
                .to_string(),
            ),
            Some(good.clone()),
        ],
    ];
    for replies in cases {
        let runner = Arc::new(Sequence(StdMutex::new(replies), Recorder::new("")));
        assert!(boot(runner.clone(), &paths, "dev").is_none());
        assert!(runner.1.calls.lock().unwrap().is_empty());
    }
    // Another VM with the same name inside the turn: the label differs, nothing runs.
    let runner = Arc::new(Sequence(
        StdMutex::new(vec![
            Some(good.clone()),
            Some(
                running(
                    json!({"labels":{"silo.machine-id":"someone-else"}}),
                    Some("one"),
                )
                .to_string(),
            ),
        ]),
        Recorder::new(""),
    ));
    boot(runner.clone(), &paths, "dev").unwrap().join().unwrap();
    assert!(runner.1.calls.lock().unwrap().is_empty());
}

/// MicroSandbox 0.7.6 reports no `runtime_instance_id`; the runtime's last-update time
/// identifies the running instance instead, so computer use still sets itself up and a
/// restart between the boot and the launch (a new update time) is still refused.
#[test]
fn the_runtime_update_time_identifies_an_instance_when_no_instance_id_is_reported() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    struct Sequence(StdMutex<Vec<&'static str>>, Recorder);
    impl RuntimeRunner for Sequence {
        fn run(
            &self,
            paths: &RuntimePaths,
            args: &[String],
            timeout: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            if args.first().is_some_and(|a| a == "inspect") {
                let mut times = self.0.lock().unwrap();
                let updated = if times.len() > 1 {
                    times.remove(0)
                } else {
                    times[0]
                };
                return Ok(CommandOutput {
                    stdout: json!({"name":"dev","status":"Running","updated_at":updated,
                        "config":{"labels":{"silo.machine-id":VM_ID}}})
                    .to_string(),
                    stderr: String::new(),
                });
            }
            self.1.run(paths, args, timeout)
        }
    }
    let same = Arc::new(Sequence(
        StdMutex::new(vec!["2026-10-02T13:37:51Z"]),
        Recorder::new(""),
    ));
    boot(same.clone(), &paths, "dev").unwrap().join().unwrap();
    assert!(!same.1.calls.lock().unwrap().is_empty());
    let restarted = Arc::new(Sequence(
        StdMutex::new(vec!["2026-10-02T13:37:51Z", "2026-10-02T13:40:00Z"]),
        Recorder::new(""),
    ));
    boot(restarted.clone(), &paths, "dev")
        .unwrap()
        .join()
        .unwrap();
    assert!(restarted.1.calls.lock().unwrap().is_empty());
}

#[test]
fn a_saved_approval_change_whose_sync_never_launched_is_finished_at_app_start() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let guest = Arc::new(SimulatedGuest::new());
    // The guest applied `ask` for this computer, then the app saved `auto` and quit
    // before the sync it would have started.
    boot(guest.clone(), &paths, "dev").unwrap().join().unwrap();
    assert_eq!(guest.applied_mode().0, "ask");
    let saved = set_approval(&paths, VM_ID, Approval::Auto).unwrap();
    let launched = guest.launches.lock().unwrap().len();
    let shared: SharedRunner = guest.clone();
    let started = reconcile_in(test_gate(), &shared, &paths, &["dev".to_owned()]);
    assert_eq!(started.len(), 1);
    for handle in started {
        handle.join().unwrap();
    }
    assert_eq!(guest.launches.lock().unwrap().len(), launched + 1);
    assert_eq!(guest.applied_mode(), ("auto".into(), saved));
    // Nothing behind: nothing launched.
    assert!(reconcile_in(test_gate(), &shared, &paths, &["dev".to_owned()]).is_empty());
    assert_eq!(guest.launches.lock().unwrap().len(), launched + 1);
}

#[test]
fn app_start_also_resyncs_a_guest_holding_another_computers_choice_or_no_helper() {
    let directory = tempfile::tempdir().unwrap();
    let paths = paths(&directory);
    write_machines(&paths, true);
    let guest = imported_guest("auto");
    let shared: SharedRunner = guest.clone();
    for handle in reconcile_in(test_gate(), &shared, &paths, &["dev".to_owned()]) {
        handle.join().unwrap();
    }
    assert_eq!(guest.applied_mode().0, "ask");
    // No helper in the guest yet (empty status): synced. Stopped or unknown names: ignored.
    let bare = Arc::new(Booting {
        inner: Recorder::new("{}"),
        instance: StdMutex::new("one".into()),
    });
    let shared: SharedRunner = bare.clone();
    let names = ["dev".to_owned(), "other".to_owned()];
    let started = reconcile_in(test_gate(), &shared, &paths, &names);
    assert_eq!(started.len(), 1, "the unknown VM is skipped");
    for handle in started {
        handle.join().unwrap();
    }
    assert!(bare.inner.scripts().iter().any(|s| s.contains("setsid")));
}

#[test]
fn an_older_launchers_success_never_clears_a_newer_failure() {
    let id = "00000000-0000-4000-8000-0000000000f5";
    record_apply(id, 10, false);
    record_apply(id, 11, false);
    assert!(apply_failed(id, 11));
    // The launcher for revision 10 finishes late.
    record_apply(id, 10, true);
    assert!(apply_failed(id, 11), "R+1's failure survives R's success");
    // A late failure of an older revision never lowers the newer record.
    record_apply(id, 9, false);
    assert!(apply_failed(id, 11));
    // A success at or above the failure clears it.
    record_apply(id, 11, true);
    assert!(!apply_failed(id, 11));
    record_apply(id, 12, false);
    record_apply(id, 13, true);
    assert!(!apply_failed(id, 12));
    forget_failure(id);
}

#[test]
fn the_shared_folder_is_prepared_again_when_the_start_up_attempt_failed() {
    let _state = crate::test_support::global_state();
    reset_published_for_test();
    set_test_published_dir(None);
    let directory = tempfile::tempdir().unwrap();
    // Start-up could not create the folders (a plain file is in the way).
    let blocker = directory.path().join("blocked");
    fs::write(&blocker, b"x").unwrap();
    let root = blocker.join("chatgpt");
    assert!(register_published(&root).is_err());
    assert!(mount_args(&machine(true)).is_err());
    // The cause goes away; neither a restart nor a preparation attempt has run yet:
    // the next VM that needs the folder prepares it itself.
    fs::remove_file(&blocker).unwrap();
    let args = mount_args(&machine(true)).unwrap();
    let dir = published_dir().expect("the folder is registered");
    assert!(
        dir.ends_with("chatgpt/published") && dir.is_dir(),
        "{dir:?}"
    );
    assert_eq!(args, ["-v", &format!("{}:{GUEST_MOUNT}:ro", dir.display())]);
    // A preparation attempt registers it as well (the worker calls this every time).
    reset_published_for_test();
    let dir = register_published(&directory.path().join("chatgpt")).unwrap();
    assert_eq!(published_dir(), Some(dir));
    reset_published_for_test();
}
