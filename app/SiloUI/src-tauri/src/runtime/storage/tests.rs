use super::*;

fn fixture() -> (tempfile::TempDir, RuntimePaths, MachineConfiguration, InspectedSandbox) {
    let directory = tempfile::tempdir().unwrap();
    let paths = super::super::tests::paths(&directory);
    let machine = MachineConfiguration::Vm {
        id: "00000000-0000-4000-8000-000000000001".into(), name: "dev".into(),
        cpus: 1, max_cpus: 1, memory_gib: 1, max_memory_gib: 1,
        workspace_storage_gib: 1, runtime_storage_gib: 1, desktop: None,
    };
    write_metadata(&paths.metadata, &MachineConfigurationRequest { schema_version: 1, machines: vec![machine.clone()] }).unwrap();
    fs::create_dir_all(paths.volumes.join("dev")).unwrap();
    fs::write(disk_path(&paths, "dev", "workspace"), vec![7u8; 8192]).unwrap();
    let observed = serde_json::from_value(json!({"name":"dev", "status":"Running", "runtime_instance_id":"run-1", "config": {
        "labels":{"silo.managed":"true","silo.machine-id":machine.id()},
        "mounts":[{"type":"DiskImage","host":disk_path(&paths,"dev","workspace"),"guest":"/workspace","format":"Raw","fstype":"ext4"}]
    }})).unwrap();
    verified_starts().lock().unwrap().insert((paths.home.clone(), machine.id().into()), "run-1".into());
    (directory, paths, machine, observed)
}
struct Runner { calls: Mutex<Vec<Vec<String>>>, fail: bool, truncate: bool }
impl Runner { fn new() -> Self { Self { calls: Mutex::new(vec![]), fail: false, truncate: false } } }
impl RuntimeRunner for Runner {
    fn run(&self, paths: &RuntimePaths, args: &[String], timeout: Duration) -> Result<CommandOutput, RuntimeError> {
        self.calls.lock().unwrap().push(args.to_vec());
        if args[0] == "--silo-storage-protocol" {
            return Ok(CommandOutput { stdout: "1\n".into(), stderr: String::new() });
        }
        assert_eq!(args[0], "exec");
        assert!(args.iter().any(|arg| arg == "--no-start"));
        assert!(timeout <= TRIM_BUDGET);
        if self.truncate { fs::OpenOptions::new().write(true).open(disk_path(paths,"dev","workspace")).unwrap().set_len(4096).unwrap(); }
        if self.fail { return Err(RuntimeError::TimedOut { operation: "trim".into() }); }
        Ok(CommandOutput { stdout: "4096 8192\n".into(), stderr: String::new() })
    }
}

#[test]
fn exact_intervals_and_clock_rollback() {
    assert!(due(&Record::default(), 0, WEEK));
    let record = Record { last_trim_at: Some(100), last_attempt_at: Some(100), ..Record::default() };
    assert!(!due(&record, 100 + DAY - 1, DAY));
    assert!(due(&record, 100 + DAY, DAY));
    assert!(!due(&record, 100 + WEEK - 1, WEEK));
    assert!(due(&record, 100 + WEEK, WEEK));
    assert!(!due(&record, 50, DAY));
    let failed = Record { last_attempt_at: Some(100), ..Record::default() };
    assert!(!due(&failed, 100 + DAY - 1, WEEK));
    assert!(due(&failed, 100 + DAY, WEEK));
}
#[test]
fn manual_reclaim_bypasses_schedule_and_persists_actual_host_result() {
    let (_dir, paths, machine, observed) = fixture();
    let runner = Runner::new();
    trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).unwrap();
    trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).unwrap();
    let record = load(&paths, machine.id()).unwrap();
    assert!(record.last_trim_at.is_some());
    assert_eq!(record.last_reclaimed_bytes, Some(0)); // Never use fstrim's logical byte count.
    assert!(record.last_error.is_none());
    assert_eq!(runner.calls.lock().unwrap().len(), 2);
    assert!(runner.calls.lock().unwrap()[0].iter().any(|s| s.contains("timeout -k 1s")));
}
#[test]
fn failure_is_durable_and_does_not_count_as_success_or_block_stop() {
    let (_dir, paths, machine, observed) = fixture();
    let runner = Runner { fail: true, ..Runner::new() };
    before_stop(&runner, &paths, &observed);
    let record = load(&paths, machine.id()).unwrap();
    assert!(record.last_trim_at.is_none());
    assert!(record.last_error.is_some());
    assert!(!due(&record, now(), DAY));
    before_stop(&runner, &paths, &observed);
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
}
#[test]
fn rejects_stopped_replaced_and_wrong_mount_without_guest_execution() {
    let (_dir, paths, machine, mut observed) = fixture();
    let runner = Runner::new();
    observed.status = "Stopped".into();
    assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).is_err());
    observed.status = "Running".into();
    observed.config["labels"]["silo.machine-id"] = json!("replacement");
    assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).is_err());
    observed.config["labels"]["silo.machine-id"] = json!(machine.id());
    observed.active_config = Some(json!({"mounts":[]}));
    assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).is_err());
    observed.active_config = None;
    observed.config["mounts"][0]["host"] = json!("/other/disk.raw");
    assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).is_err());
    assert!(runner.calls.lock().unwrap().is_empty());
}
#[test]
fn stopped_usage_reports_allocated_blocks_without_starting_guest() {
    let (_dir, paths, machine, mut observed) = fixture();
    observed.status = "Stopped".into();
    let runner = Runner::new();
    let value = state(&runner, &paths, &machine, &observed).unwrap();
    assert_eq!(value.workspace_host_bytes, allocated(&disk_path(&paths,"dev","workspace")).unwrap());
    assert_eq!(value.workspace_used_bytes, None);
    assert!(runner.calls.lock().unwrap().is_empty());
}
#[test]
fn runtime_tail_truncation_is_repaired_and_reported_even_on_timeout() {
    for fail in [false, true] {
        let (_dir, paths, machine, observed) = fixture();
        let runner = Runner { fail, truncate: true, ..Runner::new() };
        assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).unwrap_err().to_string().contains("original length was restored"));
        let content = fs::read(disk_path(&paths,"dev","workspace")).unwrap();
        assert_eq!(content.len(), 8192);
        assert_eq!(&content[..4096], &[7;4096]);
        let record = load(&paths, machine.id()).unwrap();
        assert!(record.last_trim_at.is_none());
    }
}
#[test]
fn expired_budget_does_not_enter_guest_or_record_attempt() {
    let (_dir, paths, machine, observed) = fixture();
    let runner = Runner::new();
    assert!(trim(&runner, &paths, &machine, &observed, Duration::from_secs(3), now()).is_err());
    assert!(runner.calls.lock().unwrap().is_empty());
    assert!(load(&paths, machine.id()).unwrap().last_attempt_at.is_none());
}
#[test]
fn malformed_measurements_and_history_are_not_silent_success() {
    assert!(stats("999 100").is_err());
    assert!(stats("1 2 3").is_err());
    assert!(stats("-1 2").is_err());
    assert_eq!(stats(" 123 456\n").unwrap(), (123,456));
    let (_dir, paths, machine, observed) = fixture();
    fs::create_dir_all(record_path(&paths, machine.id()).parent().unwrap()).unwrap();
    fs::write(record_path(&paths, machine.id()), b"broken").unwrap();
    let runner = Runner::new();
    assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).is_err());
    assert!(runner.calls.lock().unwrap().is_empty());
    assert_eq!(fs::read(record_path(&paths, machine.id())).unwrap(), b"broken");
}

#[test]
fn normal_stop_completes_after_a_failed_trim_and_does_not_retry_it() {
    struct LifecycleRunner { running: Mutex<bool>, calls: Mutex<Vec<String>>, config: Value }
    impl RuntimeRunner for LifecycleRunner {
        fn run(&self, _: &RuntimePaths, args: &[String], _: Duration) -> Result<CommandOutput, RuntimeError> {
            self.calls.lock().unwrap().push(args[0].clone());
            let stdout = match args[0].as_str() {
                "inspect" => json!({"name":"dev", "runtime_instance_id":"run-1", "status": if *self.running.lock().unwrap() {"Running"} else {"Stopped"}, "config":self.config}).to_string(),
                "exec" => return Err(RuntimeError::TimedOut { operation: "trim".into() }),
                "stop" => { *self.running.lock().unwrap() = false; String::new() }
                other => panic!("Unexpected command: {other}"),
            };
            Ok(CommandOutput { stdout, stderr: String::new() })
        }
    }
    let (_dir, paths, machine, observed) = fixture();
    let runner = LifecycleRunner { running: Mutex::new(true), calls: Mutex::new(vec![]), config: observed.config };
    let host = HostResources { logical_cpus: 0, physical_memory_bytes: None };
    lifecycle_recovery::perform(&runner, &paths, &host, "stop", "dev").unwrap();
    assert!(!*runner.running.lock().unwrap());
    assert_eq!(*runner.calls.lock().unwrap(), ["inspect", "exec", "stop", "inspect"]);
    assert!(load(&paths, machine.id()).unwrap().last_error.is_some());
}

#[test]
fn next_start_trims_once_and_recent_success_skips_automatic_work() {
    let (_dir, paths, machine, observed) = fixture();
    let runner = Runner::new();
    verified_starts().lock().unwrap().remove(&(paths.home.clone(), machine.id().into()));
    after_start(&runner, &paths, &observed);
    before_stop(&runner, &paths, &observed);
    after_start(&runner, &paths, &observed);
    assert_eq!(runner.calls.lock().unwrap().iter().filter(|args| args[0] == "exec").count(), 1);
    assert!(load(&paths, machine.id()).unwrap().last_trim_at.is_some());
}

#[test]
fn old_or_replaced_worker_requires_restart_before_any_trim() {
    let (_dir, paths, machine, mut observed) = fixture();
    let runner = Runner::new();
    observed.runtime_instance_id = Some("different-run".into());
    assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).unwrap_err().to_string().contains("Restart this VM"));
    observed.runtime_instance_id = None;
    assert!(trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now()).is_err());
    assert!(runner.calls.lock().unwrap().is_empty());
}

#[test]
fn periodic_reclaims_due_running_vm_once_without_starting_any_vm() {
    struct PeriodicRunner { guest: Runner, config: Value, inspections: Mutex<usize> }
    impl RuntimeRunner for PeriodicRunner {
        fn run(&self, paths: &RuntimePaths, args: &[String], timeout: Duration) -> Result<CommandOutput, RuntimeError> {
            if args[0] == "inspect" {
                *self.inspections.lock().unwrap() += 1;
                return Ok(CommandOutput { stdout: json!({"name":"dev", "status":"Running", "runtime_instance_id":"run-1", "config":self.config}).to_string(), stderr: String::new() });
            }
            self.guest.run(paths, args, timeout)
        }
    }
    let (_dir, paths, machine, observed) = fixture();
    let runner = PeriodicRunner { guest: Runner::new(), config: observed.config, inspections: Mutex::new(0) };
    save(&paths, machine.id(), &Record { last_trim_at: Some(now() - WEEK), last_attempt_at: Some(now() - WEEK), ..Record::default() }).unwrap();
    assert!(periodic(&runner, &paths).unwrap());
    assert!(!periodic(&runner, &paths).unwrap());
    assert_eq!(*runner.inspections.lock().unwrap(), 1);
    assert_eq!(runner.guest.calls.lock().unwrap().len(), 1);
}

#[test]
fn unavailable_guest_stats_do_not_hide_a_maintenance_failure() {
    let (_dir, paths, machine, observed) = fixture();
    let runner = Runner { fail: true, ..Runner::new() };
    save(&paths, machine.id(), &Record { last_error: Some("Preserved maintenance failure".into()), ..Record::default() }).unwrap();
    let value = state(&runner, &paths, &machine, &observed).unwrap();
    assert_eq!(value.last_error.as_deref(), Some("Preserved maintenance failure"));
    assert_eq!(value.workspace_used_bytes, None);
}

#[test]
fn starting_vm_does_not_begin_maintenance_during_quit() {
    const CHILD: &str = "SILO_STORAGE_QUIT_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "runtime::storage::tests::starting_vm_does_not_begin_maintenance_during_quit"])
            .env(CHILD, "1").output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        return;
    }
    // Isolated process: do not change the global Quit state of parallel tests.
    let (_dir, paths, machine, observed) = fixture();
    let runner = Runner::new();
    shutdown::begin();
    after_start(&runner, &paths, &observed);
    assert!(runner.calls.lock().unwrap().is_empty());
    assert!(load(&paths, machine.id()).unwrap().last_attempt_at.is_none());
}

// Explicitly opt-in: boots and trims the named local VM, preserving its files.
// Keep separate from ordinary tests and never distribute the test executable.
#[test]
#[ignore = "requires explicit live VM runtime, home, identity and baseline checksum"]
fn live_reclaim_preserves_capacity_contents_and_reboots() {
    let executable = PathBuf::from(std::env::var("SILO_STORAGE_LIVE_RUNTIME").expect("explicit runtime path required"));
    let home = PathBuf::from(std::env::var("SILO_STORAGE_LIVE_HOME").expect("explicit runtime home required"));
    let id = std::env::var("SILO_STORAGE_LIVE_ID").expect("explicit VM ID required");
    let expected_hash = std::env::var("SILO_STORAGE_EXPECTED_SHA256").expect("pre-existing workspace checksum required");
    let storage = fs::canonicalize(&home).unwrap().parent().unwrap().to_path_buf();
    let library = executable.parent().unwrap().parent().unwrap().join("Frameworks/libkrunfw.5.dylib");
    assert!(library.is_file());
    let paths = RuntimePaths { executable, library, home, storage_home: None,
        metadata: storage.join("machines.json"), volumes: storage.join("volumes"), guest_image: storage.join("unused-image") };
    let _guard = MUTATION_LOCK.lock().unwrap();
    let machine = machine(&paths, &id).unwrap();
    let runner = ProcessRunner;
    let initial = inspect_workspace(&runner, &paths, machine.name()).unwrap();
    assert!(initial.status.eq_ignore_ascii_case("stopped"), "Do not interrupt an existing running VM");
    let disk = disk_path(&paths, machine.name(), "workspace");
    let length = fs::metadata(&disk).unwrap().len();
    let host = host_resources().unwrap();
    let checksum = "set -eu; find /workspace -xdev -type f -exec sha256sum {} + | LC_ALL=C sort | sha256sum";
    let mut previous_instance = None;
    for _ in 0..2 {
        let result = (|| -> Result<(), RuntimeError> {
            lifecycle_recovery::perform(&runner, &paths, &host, "start", machine.name())?;
            let observed = inspect_workspace(&runner, &paths, machine.name())?;
            if !verified_worker(&paths, &machine, &observed) || observed.runtime_instance_id == previous_instance {
                return Err(failure("The newly started runtime instance was not verified."));
            }
            previous_instance = observed.runtime_instance_id.clone();
            let before = runner.run(&paths, &guest_args(machine.name(), 29, checksum), Duration::from_secs(30))?;
            if before.stdout.split_whitespace().next() != Some(expected_hash.as_str()) {
                return Err(failure("Workspace checksum differs from the pre-existing baseline."));
            }
            trim(&runner, &paths, &machine, &observed, TRIM_BUDGET, now())?;
            let after = runner.run(&paths, &guest_args(machine.name(), 29, checksum), Duration::from_secs(30))?;
            if after.stdout != before.stdout || fs::metadata(&disk).unwrap().len() != length {
                return Err(failure("Workspace contents or logical capacity changed."));
            }
            let measurements = state(&runner, &paths, &machine, &observed)?;
            if measurements.workspace_used_bytes.is_none() || measurements.last_error.is_some() {
                return Err(failure("Live storage measurements or trim result were unavailable."));
            }
            println!("Verified live storage: {}", serde_json::to_string(&measurements).unwrap());
            Ok(())
        })();
        let stopped = lifecycle_recovery::perform(&runner, &paths, &host, "stop", machine.name());
        result.unwrap();
        stopped.unwrap();
        assert_eq!(fs::metadata(&disk).unwrap().len(), length);
        assert!(inspect_workspace(&runner, &paths, machine.name()).unwrap().status.eq_ignore_ascii_case("stopped"));
    }
}

#[test]
fn history_retains_latest_fifty_attempts_including_failures() {
    let (_dir, paths, machine, observed) = fixture();
    for at in 0..51 {
        trim_triggered(&Runner::new(), &paths, &machine, &observed, TRIM_BUDGET, at, "scheduled").unwrap();
    }
    let failing = Runner { fail: true, ..Runner::new() };
    assert!(trim_triggered(&failing, &paths, &machine, &observed, TRIM_BUDGET, 51, "manual").is_err());
    let record = load(&paths, machine.id()).unwrap();
    assert_eq!(record.history.len(), 50);
    assert_eq!(record.history[0].at, 51);
    assert_eq!(record.history[49].at, 2);
    assert_eq!(record.history[0].trigger, "manual");
    assert!(record.history[0].error.is_some());
    assert_eq!(record.history[0].reclaimed_bytes, None);
    assert_eq!(record.history[1].trigger, "scheduled");
    assert_eq!(record.history[1].reclaimed_bytes, Some(0));
    assert!(record.history[1].error.is_none());
}

#[test]
fn legacy_record_keeps_last_success_when_history_is_introduced() {
    let (_dir, paths, machine, _) = fixture();
    let path = record_path(&paths, machine.id());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, r#"{"lastTrimAt":100,"lastAttemptAt":100,"lastReclaimedBytes":2048,"lastError":null}"#).unwrap();
    let record = load(&paths, machine.id()).unwrap();
    assert_eq!(record.history.len(), 1);
    assert_eq!(record.history[0].at, 100);
    assert_eq!(record.history[0].reclaimed_bytes, Some(2048));
    assert_eq!(record.history[0].trigger, "legacy");
    save(&paths, machine.id(), &record).unwrap();
    assert_eq!(load(&paths, machine.id()).unwrap().history.len(), 1);
}
