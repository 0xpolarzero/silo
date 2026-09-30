use super::*;
use std::os::fd::AsRawFd;

const OWNER: &str = ".silo-configuration-owner";
/// Set once startup recovery has run (successfully or not) in this process.
static STARTUP_SETTLED: AtomicBool = AtomicBool::new(false);
/// Configuration attempts currently running in this process.
static LIVE_ATTEMPTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Marks a configuration attempt as live for as long as it is held. A saved
/// journal blocks snapshots only while an attempt is live (or before startup
/// recovery has run), so an attempt that fails in-session no longer freezes
/// the sandbox list until relaunch.
#[must_use]
pub(super) struct Attempt(());
impl Drop for Attempt {
    fn drop(&mut self) { LIVE_ATTEMPTS.fetch_sub(1, Ordering::SeqCst); }
}
pub(super) fn attempt() -> Attempt {
    LIVE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    Attempt(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    previous: MachineConfigurationRequest,
    request: MachineConfigurationRequest,
}

fn path(paths: &RuntimePaths) -> PathBuf { paths.metadata.with_file_name("configuration-operation.json") }
fn failure(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Unavailable(format!("Could not recover sandbox configuration: {error}"))
}
fn load(paths: &RuntimePaths) -> Result<Option<Journal>, RuntimeError> {
    let file = match File::open(path(paths)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error)),
    };
    let journal: Journal = serde_json::from_reader(file.take(MAX_OUTPUT_BYTES)).map_err(failure)?;
    if journal.version != 1 { return Err(failure("Unsupported saved operation; it was preserved.")); }
    // First-run metadata is legitimately empty; submitted configurations are not.
    if !journal.previous.machines.is_empty() || journal.previous.schema_version != 1 {
        validate_request(&journal.previous)?;
    }
    validate_request(&journal.request)?;
    Ok(Some(journal))
}

/// Include VMs created before their metadata commit without replaying setup on Quit.
pub(super) fn shutdown_machines(paths: &RuntimePaths) -> Result<Vec<MachineConfiguration>, RuntimeError> {
    let Some(journal) = load(paths)? else { return Ok(Vec::new()); };
    let mut machines = journal.previous.machines;
    for machine in journal.request.machines {
        if !machines.iter().any(|old| old.id() == machine.id()) { machines.push(machine); }
    }
    Ok(machines.into_iter().filter(MachineConfiguration::is_vm).collect())
}

/// The target configuration of an interrupted attempt, if one is pending. Used by the
/// retry command to resume that attempt against current state without the UI resending
/// the whole list.
pub(super) fn pending_request(paths: &RuntimePaths) -> Result<Option<MachineConfigurationRequest>, RuntimeError> {
    Ok(load(paths)?.map(|journal| journal.request))
}

pub(super) fn begin(paths: &RuntimePaths, request: &MachineConfigurationRequest) -> Result<(), RuntimeError> {
    if let Some(saved) = load(paths)? {
        if saved.request == *request { return Ok(()); }
        return Err(failure("An interrupted configuration is pending. Relaunch Silo to resume it before making another change."));
    }
    let journal = Journal { version: 1, previous: read_metadata(&paths.metadata)?, request: request.clone() };
    write(paths, &journal)
}

fn write(paths: &RuntimePaths, journal: &Journal) -> Result<(), RuntimeError> {
    let parent = paths.metadata.parent().ok_or_else(|| failure("Missing storage directory."))?;
    fs::create_dir_all(parent).map_err(failure)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(failure)?;
    serde_json::to_writer(&mut file, &journal).map_err(failure)?;
    file.as_file().sync_all().map_err(failure)?;
    file.persist(path(paths)).map_err(failure)?;
    File::open(parent).and_then(|file| file.sync_all()).map_err(failure)
}

// Reserve new storage before formatting. The marker permits cleanup only of
// files created for this exact, not-yet-committed sandbox ID.
pub(super) fn claim(paths: &RuntimePaths, machine: &MachineConfiguration) -> Result<(), RuntimeError> {
    let Some(journal) = load(paths)? else { return Ok(()); };
    if journal.previous.machines.iter().any(|old| old.id() == machine.id()) { return Ok(()); }
    let folder = paths.volumes.join(machine.name());
    fs::create_dir_all(&paths.volumes).map_err(failure)?;
    if folder.exists() {
        // Reuse only an empty directory, including leftovers from older builds.
        fs::remove_dir(&folder).map_err(|_| failure("New sandbox storage is already occupied. No existing files were changed."))?;
    }
    let stage = tempfile::Builder::new().prefix(".configuration-claim-").tempdir_in(&paths.volumes).map_err(failure)?;
    let mut marker = fs::OpenOptions::new().create_new(true).write(true).open(stage.path().join(OWNER)).map_err(failure)?;
    marker.write_all(machine.id().as_bytes()).and_then(|_| marker.sync_all()).map_err(failure)?;
    File::open(stage.path()).and_then(|file| file.sync_all()).map_err(failure)?;
    fs::rename(stage.path(), &folder).map_err(failure)?;
    File::open(&paths.volumes).and_then(|file| file.sync_all()).map_err(failure)
}

pub(super) fn finish(paths: &RuntimePaths) -> Result<(), RuntimeError> {
    if let Some(journal) = load(paths)? {
        for machine in &journal.request.machines {
            let marker = paths.volumes.join(machine.name()).join(OWNER);
            if fs::read_to_string(&marker).ok().as_deref() == Some(machine.id()) {
                fs::remove_file(&marker).map_err(failure)?;
                File::open(marker.parent().unwrap()).and_then(|file| file.sync_all()).map_err(failure)?;
            }
        }
        fs::remove_file(path(paths)).map_err(failure)?;
        File::open(paths.metadata.parent().unwrap()).and_then(|file| file.sync_all()).map_err(failure)?;
    }
    Ok(())
}

/// A parent-held command lock releases the shared flock even when a concurrent
/// fork temporarily inherited its descriptor before exec closed it.
pub(crate) struct CommandLock {
    file: File,
    inherited_by_child: bool,
    release_on_drop: bool,
}

impl CommandLock {
    /// A shutdown worker shares the parent's flock. Only the parent unlocks after
    /// all workers have joined; each runtime child still inherits its own descriptor.
    pub(crate) fn duplicate_for_shutdown(&self) -> Result<Self, RuntimeError> {
        Ok(Self { file: self.file.try_clone().map_err(failure)?, inherited_by_child: false, release_on_drop: false })
    }

    /// Keep the flock until the deliberately inheriting runtime child exits.
    /// Call only after a child with the lock's close-on-exec flag cleared spawned.
    pub(crate) fn mark_inherited_by_child(&mut self) {
        self.inherited_by_child = true;
    }

    /// Once the child is reaped, the parent can release any copies temporarily
    /// inherited by unrelated forks while that child was running.
    pub(crate) fn mark_child_exited(&mut self) {
        self.inherited_by_child = false;
    }
}

impl AsRawFd for CommandLock {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.file.as_raw_fd()
    }
}

impl Drop for CommandLock {
    fn drop(&mut self) {
        if self.release_on_drop && !self.inherited_by_child {
            // SAFETY: this descriptor remains owned by self until after Drop.
            // LOCK_UN also releases copies inherited by unrelated forks.
            unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN); }
        }
    }
}

pub(crate) fn command_lock(paths: &RuntimePaths, timeout: Duration) -> Result<CommandLock, RuntimeError> {
    prepare_runtime_home(&paths.home, paths.storage_home.as_deref())?;
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(paths.home.join(".silo-configuration-worker.lock")).map_err(failure)?;
    let started = Instant::now();
    loop {
        // SAFETY: the open file owns this descriptor until the lock is dropped.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(CommandLock { file, inherited_by_child: false, release_on_drop: true });
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::WouldBlock { return Err(failure(error)); }
        if started.elapsed() >= timeout { return Err(failure("The previous sandbox command is still finishing. Retry after it exits.")); }
        thread::sleep(Duration::from_millis(100));
    }
}

fn reconcile(runner: &dyn RuntimeRunner, paths: &RuntimePaths, journal: &Journal) -> Result<(), RuntimeError> {
    let mut current = read_metadata(&paths.metadata)?;
    for machine in &current.machines {
        if !journal.previous.machines.contains(machine) && !journal.request.machines.contains(machine) {
            return Err(failure("Sandbox settings changed since the interruption. Saved data was preserved."));
        }
    }
    let listed = list_managed(runner, paths)?;
    for machine in journal.request.machines.iter().filter(|machine| machine.is_vm() && !journal.previous.machines.iter().any(|old| old.id() == machine.id())) {
        if listed.iter().any(|entry| entry.name == machine.name()) {
            let inspected = inspect_workspace(runner, paths, machine.name())?;
            ensure_managed(&inspected)?;
            if inspected.config.pointer("/labels/silo.machine-id").and_then(Value::as_str) != Some(machine.id()) {
                return Err(failure("A different sandbox now owns the requested name. Its data was preserved."));
            }
            verify_machine_configuration(runner, paths, machine)?;
            if !current.machines.iter().any(|entry| entry.id() == machine.id()) {
                crate::working_account::working_user(&inspected.config).map_err(RuntimeError::Malformed)?;
                verify_guest_tools(runner, paths, machine.name())?;
                if let Some(desktop) = crate::desktop::configuration(machine) {
                    crate::desktop::configure_with(runner, paths, machine.name(), None, desktop)?;
                    let restored = inspect_workspace(runner, paths, machine.name())?;
                    ensure_managed(&restored)?;
                    if !matches!(restored.status.as_str(), "Created" | "Stopped") {
                        return Err(failure("Desktop installation did not restore the new sandbox's stopped state."));
                    }
                }
                current.machines.push(machine.clone());
            }
        } else {
            if current.machines.iter().any(|entry| entry.id() == machine.id()) {
                return Err(failure("A saved sandbox is missing from the runtime. Its disk files were preserved."));
            }
            let folder = paths.volumes.join(machine.name());
            if folder.exists() {
                if fs::read_to_string(folder.join(OWNER)).ok().as_deref() != Some(machine.id()) {
                    if fs::remove_dir(&folder).is_ok() { continue; }
                    return Err(failure("Incomplete storage ownership could not be verified. No files were removed."));
                }
                fs::remove_dir_all(folder).map_err(failure)?;
            }
        }
    }
    for machine in journal.previous.machines.iter().filter(|machine| !journal.request.machines.iter().any(|next| next.id() == machine.id())) {
        if !machine.is_vm() || !listed.iter().any(|entry| entry.name == machine.name()) {
            crate::secrets::workspace_removed(machine.name()).map_err(failure)?;
            remove_machine_volumes(paths, machine)?;
            lifecycle_recovery::forget_removed(paths, machine)?;
            current.machines.retain(|entry| entry.id() != machine.id());
        } else {
            let inspected = inspect_workspace(runner, paths, machine.name())?;
            if inspected.config.pointer("/labels/silo.machine-id").and_then(Value::as_str) != Some(machine.id()) {
                return Err(failure("The sandbox selected for deletion changed ownership. It was preserved."));
            }
        }
    }
    if !current.machines.is_empty() || paths.metadata.exists() {
        write_metadata(&paths.metadata, &current)?;
    }
    // An interrupted removal keeps its checkpoint history until exact native members
    // have entered the cleanup journal. The updated inventory releases its own pins.
    for machine in journal.previous.machines.iter().filter(|machine| {
        !journal.request.machines.iter().any(|next| next.id() == machine.id())
            && !current.machines.iter().any(|next| next.id() == machine.id())
    }) {
        if machine.is_vm() {
            checkpoints::remove_deleted_snapshots(runner, paths, machine.id(), machine.name())?;
        }
        checkpoints::forget_removed(paths, machine.id())?;
    }
    Ok(())
}

fn verify_committed_edits(runner: &dyn RuntimeRunner, paths: &RuntimePaths, journal: &Journal, requested: &MachineConfigurationRequest) -> Result<(), RuntimeError> {
    // Metadata is committed before the final verification. An existing VM whose
    // edit reached that checkpoint still needs verification after relaunch.
    let current = read_metadata(&paths.metadata)?;
    for machine in journal.request.machines.iter().filter(|machine| machine.is_vm()
        && journal.previous.machines.iter().any(|old| old.id() == machine.id() && old != *machine)
        && current.machines.contains(machine) && requested.machines.contains(machine)) {
        let inspected = inspect_workspace(runner, paths, machine.name())?;
        ensure_managed(&inspected)?;
        if inspected.config.pointer("/labels/silo.machine-id").and_then(Value::as_str) != Some(machine.id()) {
            return Err(failure("The updated sandbox changed ownership. Its data was preserved."));
        }
        verify_machine_configuration(runner, paths, machine)?;
    }
    Ok(())
}

pub(super) fn recover_at_paths(runner: &dyn RuntimeRunner, paths: &RuntimePaths, resources: &HostResources, progress: &dyn Fn(&str, &str, u8)) -> Result<(), RuntimeError> {
    debug_assert!(operation_gate::held(), "configuration recovery requires the computer operation gate");
    let Some(journal) = load(paths)? else { return Ok(()); };
    // Drain a surviving child before inspecting state. The caller holds the
    // operation gate (computer scope), which serializes the application-level
    // recovery transaction against all other VM-changing work.
    drop(command_lock(paths, MUTATION_TIMEOUT)?);
    reconcile(runner, paths, &journal)?;
    verify_committed_edits(runner, paths, &journal, &journal.request)?;
    apply_whole_configuration_with_progress(runner, paths, resources, journal.request, None, progress)?;
    finish(paths)
}

pub(super) fn prepare_retry(runner: &dyn RuntimeRunner, paths: &RuntimePaths, request: Option<&MachineConfigurationRequest>) -> Result<(), RuntimeError> {
    let _attempt = attempt();
    if let Some(journal) = load(paths)? {
        drop(command_lock(paths, MUTATION_TIMEOUT)?);
        reconcile(runner, paths, &journal)?;
        verify_committed_edits(runner, paths, &journal, request.unwrap_or(&journal.request))?;
        if let Some(request) = request.filter(|request| **request != journal.request) {
            validate_request(request)?;
            let previous = read_metadata(&paths.metadata)?;
            for machine in &request.machines {
                if let Some(old) = previous.machines.iter().find(|old| old.id() == machine.id()) {
                    validate_machine_update(old, machine)?;
                }
            }
            for machine in &previous.machines {
                let marker = paths.volumes.join(machine.name()).join(OWNER);
                if fs::read_to_string(&marker).ok().as_deref() == Some(machine.id()) {
                    fs::remove_file(&marker).map_err(failure)?;
                    File::open(marker.parent().unwrap()).and_then(|file| file.sync_all()).map_err(failure)?;
                }
            }
            // Reconciliation has either adopted completed additions or removed
            // owned partial files. Atomically replace intent without losing the
            // committed machines that the revised request may now edit/remove.
            write(paths, &Journal { version: 1, previous, request: request.clone() })?;
        }
    }
    Ok(())
}

pub(super) fn pending(paths: &RuntimePaths) -> Result<bool, String> {
    let idle = STARTUP_SETTLED.load(Ordering::SeqCst) && LIVE_ATTEMPTS.load(Ordering::SeqCst) == 0;
    blocks_snapshot(paths, idle)
}

fn blocks_snapshot(paths: &RuntimePaths, no_live_attempt: bool) -> Result<bool, String> {
    // Once no attempt is running (startup recovery or an in-session change
    // stopped with an error), let the normal snapshot verifier show the actual
    // committed state so the user can correct the request. The saved intent,
    // activity failure and error remain; this is not completion.
    if no_live_attempt { return Ok(false); }
    load(paths).map(|journal| journal.is_some()).map_err(|e| e.to_string())
}

pub(crate) fn recover(app: &AppHandle) -> Result<(), String> {
    let result = {
        let _attempt = attempt();
        STARTUP_SETTLED.store(true, Ordering::SeqCst);
        recover_inner(app)
    };
    let _ = app.emit("silo://application-state-changed", ());
    result
}

fn recover_inner(app: &AppHandle) -> Result<(), String> {
    let paths = runtime_paths(app)?;
    if load(&paths).map_err(|e| e.to_string())?.is_none() { return Ok(()); }
    let _guard = OPERATIONS
        .computer("Recovering sandbox configuration")
        .map_err(|_| "Sandbox configuration lock is unavailable.")?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let activity = Mutex::new(ActivityJournal::start(&paths, &request_id)?);
    let progress = |step: &str, name: &str, fraction: u8| {
        let event = activity.lock().unwrap_or_else(|e| e.into_inner()).append(machine_progress(&request_id, step, name, fraction));
        let _ = app.emit_to("main", "silo://machine-configuration-progress", event);
    };
    progress("setup-started", "", 0);
    let result = host_resources().and_then(|resources| recover_at_paths(&ProcessRunner, &paths, &resources, &progress));
    progress(if result.is_ok() { "setup-completed" } else { "setup-interrupted" }, "", 0);
    let _ = app.emit("silo://application-state-changed", ());
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn ordinary_command_lock_release_survives_an_unrelated_fork() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&directory);
        for completed_child in [false, true] {
            let mut lock = command_lock(&paths, Duration::ZERO).unwrap();
            if completed_child {
                lock.mark_inherited_by_child();
                lock.mark_child_exited();
            }
            let mut ready = [0; 2];
            let mut release = [0; 2];
            // SAFETY: only async-signal-safe libc calls run in the child. The pipes
            // keep it alive until the parent has tested the inherited descriptor.
            unsafe {
                assert_eq!(libc::pipe(ready.as_mut_ptr()), 0);
                assert_eq!(libc::pipe(release.as_mut_ptr()), 0);
                let child = libc::fork();
                assert!(child >= 0);
                if child == 0 {
                    libc::close(ready[0]);
                    libc::close(release[1]);
                    let marker = [1u8];
                    libc::write(ready[1], marker.as_ptr().cast(), 1);
                    let mut finish = [0u8];
                    libc::read(release[0], finish.as_mut_ptr().cast(), 1);
                    libc::_exit(0);
                }
                libc::close(ready[1]);
                libc::close(release[0]);
                let mut marker = [0u8];
                assert_eq!(libc::read(ready[0], marker.as_mut_ptr().cast(), 1), 1);
                drop(lock);
                let reacquired = command_lock(&paths, Duration::ZERO).is_ok();
                libc::write(release[1], marker.as_ptr().cast(), 1);
                assert_eq!(libc::waitpid(child, std::ptr::null_mut(), 0), child);
                libc::close(ready[0]);
                libc::close(release[1]);
                assert!(reacquired, "an unrelated fork kept the released command lock");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn deliberately_inherited_command_lock_survives_parent_release() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&directory);
        let mut lock = command_lock(&paths, Duration::ZERO).unwrap();
        let mut ready = [0; 2];
        let mut release = [0; 2];
        // SAFETY: only async-signal-safe libc calls run in the child.
        unsafe {
            assert_eq!(libc::pipe(ready.as_mut_ptr()), 0);
            assert_eq!(libc::pipe(release.as_mut_ptr()), 0);
            let child = libc::fork();
            assert!(child >= 0);
            if child == 0 {
                libc::close(ready[0]);
                libc::close(release[1]);
                let marker = [1u8];
                libc::write(ready[1], marker.as_ptr().cast(), 1);
                let mut finish = [0u8];
                libc::read(release[0], finish.as_mut_ptr().cast(), 1);
                libc::_exit(0);
            }
            libc::close(ready[1]);
            libc::close(release[0]);
            let mut marker = [0u8];
            assert_eq!(libc::read(ready[0], marker.as_mut_ptr().cast(), 1), 1);
            lock.mark_inherited_by_child();
            drop(lock);
            let held = command_lock(&paths, Duration::ZERO).is_err();
            libc::write(release[1], marker.as_ptr().cast(), 1);
            assert_eq!(libc::waitpid(child, std::ptr::null_mut(), 0), child);
            libc::close(ready[0]);
            libc::close(release[1]);
            assert!(held, "the surviving child lost the command lock");
            drop(command_lock(&paths, Duration::ZERO).unwrap());
        }
    }

    #[test]
    fn working_account_recovery_provisions_only_labelled_interrupted_creations() {
        let _test_state = crate::test_support::global_state();
        struct InterruptedRuntime {
            inspected: Value,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for InterruptedRuntime {
            fn run(&self, _paths: &RuntimePaths, args: &[String], _timeout: Duration) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let value = match args[0].as_str() {
                    "list" => json!([{"name":"dev"}]),
                    "inspect" => self.inspected.clone(),
                    "exec" => Value::Null,
                    other => panic!("Unexpected recovery operation: {other}"),
                };
                Ok(CommandOutput { stdout: value.to_string(), stderr: String::new() })
            }
        }
        for unified in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let paths = RuntimePaths { executable: root.join("msb"), library: root.join("library"), home: root.join("home"), storage_home: None, guest_image: root.join("image"), metadata: root.join("machines.json"), volumes: root.join("volumes") };
            let machine = MachineConfiguration::Vm { id: uuid::Uuid::new_v4().to_string(), name: "dev".into(), cpus: 1, max_cpus: 2, memory_gib: 4, max_memory_gib: 8, workspace_storage_gib: 10, runtime_storage_gib: 10, desktop: None };
            let request = MachineConfigurationRequest { schema_version: 1, machines: vec![machine.clone()] };
            begin(&paths, &request).unwrap();
            claim(&paths, &machine).unwrap();
            let mut inspected = json!({"name":"dev","status":"Stopped","config":{
                "image":{"Oci":{"root_disk":{"kind":"managed","size_mib":10240}}},
                "resources":{"cpus":1,"max_cpus":2,"memory_mib":4096,"max_memory_mib":8192},
                "labels":{"silo.managed":"true","silo.machine-id":machine.id()},
                "mounts":[{"type":"Owned","guest":"/workspace","storage":{"kind":"disk","capacity_mib":10240}}]
            }});
            if unified { inspected["config"]["labels"]["silo.working-account"] = json!("1"); }
            let runner = InterruptedRuntime { inspected, calls: Mutex::new(Vec::new()) };
            if !unified {
                assert!(prepare_retry(&runner, &paths, None).unwrap_err().to_string().contains("Migrate"));
                assert!(!runner.calls.lock().unwrap().iter().any(|args| args[0] == "exec"));
                continue;
            }
            prepare_retry(&runner, &paths, None).unwrap();
            assert_eq!(read_metadata(&paths.metadata).unwrap(), request);
            let calls = runner.calls.lock().unwrap();
            let commands: Vec<_> = calls.iter().filter(|args| args[0] == "exec").collect();
            assert_eq!(commands.len(), 1);
            assert!(commands[0].windows(2).any(|pair| pair == ["--user","root"]));
            let script = commands[0].last().unwrap();
            assert!(script.contains(include_str!("../../guest/setup-working-account.sh")));
            drop(calls);
            // Metadata adoption makes a subsequent retry read-only for the supported policy.
            runner.calls.lock().unwrap().clear();
            prepare_retry(&runner, &paths, None).unwrap();
            assert!(!runner.calls.lock().unwrap().iter().any(|args| args[0] == "exec"));
        }
    }

    #[test]
    fn failed_recovery_unblocks_verified_current_state_without_discarding_intent() {
        let _test_state = crate::test_support::global_state();
        struct EmptyRuntime;
        impl RuntimeRunner for EmptyRuntime {
            fn run(&self, _paths: &RuntimePaths, args: &[String], _timeout: Duration) -> Result<CommandOutput, RuntimeError> {
                assert_eq!(args[0], "list");
                Ok(CommandOutput { stdout: "[]".into(), stderr: String::new() })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let paths = RuntimePaths { executable: root.join("msb"), library: root.join("library"), home: root.join("home"), storage_home: None, guest_image: root.join("image"), metadata: root.join("machines.json"), volumes: root.join("volumes") };
        let remote = MachineConfiguration::Ssh { id: uuid::Uuid::new_v4().to_string(), name: "remote".into(), host: "host".into(), user: "user".into(), port: 22 };
        let current = MachineConfigurationRequest { schema_version: 1, machines: vec![remote.clone()] };
        write_metadata(&paths.metadata, &current).unwrap();
        let new = MachineConfiguration::Vm { id: uuid::Uuid::new_v4().to_string(), name: "dev".into(), cpus: 1, max_cpus: 2, memory_gib: 4, max_memory_gib: 8, workspace_storage_gib: 10, runtime_storage_gib: 10, desktop: None };
        let request = MachineConfigurationRequest { schema_version: 1, machines: vec![remote, new] };
        begin(&paths, &request).unwrap();
        assert!(blocks_snapshot(&paths, false).unwrap());
        assert!(!blocks_snapshot(&paths, true).unwrap());
        // The existing verifier still checks real runtime state, rather than
        // presenting the pending requested VM as successfully created.
        let source = read_application_state_with(&EmptyRuntime, &paths).unwrap();
        assert_eq!(source.workspaces.len(), 1);
        assert_eq!(read_metadata(&paths.metadata).unwrap(), current);
        assert!(path(&paths).is_file());
        let mut revised = request;
        if let MachineConfiguration::Vm { memory_gib, .. } = &mut revised.machines[1] { *memory_gib = 2; }
        prepare_retry(&EmptyRuntime, &paths, Some(&revised)).unwrap();
        assert!(load(&paths).unwrap().is_some_and(|journal| journal.request == revised));
    }

    #[test]
    fn in_session_failure_stops_blocking_snapshots_but_keeps_intent() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&directory);
        let remote = MachineConfiguration::Ssh { id: uuid::Uuid::new_v4().to_string(), name: "remote".into(), host: "host".into(), user: "user".into(), port: 22 };
        write_metadata(&paths.metadata, &MachineConfigurationRequest { schema_version: 1, machines: vec![remote.clone()] }).unwrap();
        let new = MachineConfiguration::Vm { id: uuid::Uuid::new_v4().to_string(), name: "dev".into(), cpus: 1, max_cpus: 2, memory_gib: 4, max_memory_gib: 8, workspace_storage_gib: 10, runtime_storage_gib: 10, desktop: None };
        let request = MachineConfigurationRequest { schema_version: 1, machines: vec![remote, new] };
        let settled = STARTUP_SETTLED.swap(true, Ordering::SeqCst);
        let blocked_while_live = {
            let _attempt = attempt();
            begin(&paths, &request).unwrap();
            pending(&paths).unwrap()
            // The attempt fails here without `finish`.
        };
        let blocked_after_failure = pending(&paths).unwrap();
        STARTUP_SETTLED.store(settled, Ordering::SeqCst);
        assert!(blocked_while_live);
        assert!(!blocked_after_failure);
        assert!(path(&paths).is_file(), "the interrupted intent stays available for Retry");
    }

    #[test]
    fn retry_resumes_the_recorded_request_and_rejects_settings_changed_since() {
        let _test_state = crate::test_support::global_state();
        struct EmptyRuntime;
        impl RuntimeRunner for EmptyRuntime {
            fn run(&self, _paths: &RuntimePaths, args: &[String], _timeout: Duration) -> Result<CommandOutput, RuntimeError> {
                assert_eq!(args[0], "list");
                Ok(CommandOutput { stdout: "[]".into(), stderr: String::new() })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let paths = RuntimePaths { executable: root.join("msb"), library: root.join("library"), home: root.join("home"), storage_home: None, guest_image: root.join("image"), metadata: root.join("machines.json"), volumes: root.join("volumes") };
        let remote = |name: &str| MachineConfiguration::Ssh { id: uuid::Uuid::new_v4().to_string(), name: name.into(), host: "host".into(), user: "user".into(), port: 22 };
        let (a, b, c) = (remote("a"), remote("b"), remote("c"));
        // The interrupted attempt was adding "b" to an inventory that held "a".
        let previous = MachineConfigurationRequest { schema_version: 1, machines: vec![a.clone()] };
        write_metadata(&paths.metadata, &previous).unwrap();
        let request = MachineConfigurationRequest { schema_version: 1, machines: vec![a.clone(), b] };
        begin(&paths, &request).unwrap();
        // The retry command reads exactly this recorded target to resume.
        assert_eq!(pending_request(&paths).unwrap(), Some(request.clone()));
        // Someone changed the inventory since the attempt: "c" is foreign to both the
        // pre-attempt state and the recorded target, so resuming is rejected.
        write_metadata(&paths.metadata, &MachineConfigurationRequest { schema_version: 1, machines: vec![a, c] }).unwrap();
        let error = prepare_retry(&EmptyRuntime, &paths, Some(&request)).unwrap_err().to_string();
        assert!(error.contains("changed since"), "{error}");
    }
}
