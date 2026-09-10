use super::*;
use std::os::fd::AsRawFd;

const OWNER: &str = ".silo-configuration-owner";
static RECOVERY_FAILURE: Mutex<Option<String>> = Mutex::new(None);

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

pub(super) fn begin(paths: &RuntimePaths, request: &MachineConfigurationRequest) -> Result<(), RuntimeError> {
    if let Some(saved) = load(paths)? {
        if saved.request == *request { return Ok(()); }
        return Err(failure("An interrupted configuration is pending. Relaunch Silo to resume it before making another change."));
    }
    let journal = Journal { version: 1, previous: read_metadata(&paths.metadata)?, request: request.clone() };
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

pub(super) fn command_lock(paths: &RuntimePaths, timeout: Duration) -> Result<File, RuntimeError> {
    fs::create_dir_all(&paths.home).map_err(failure)?;
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(paths.home.join(".silo-configuration-worker.lock")).map_err(failure)?;
    let started = Instant::now();
    loop {
        // SAFETY: the open file owns this descriptor until the lock is dropped.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { return Ok(file); }
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
                verify_guest_tools(runner, paths, machine.name())?;
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
            current.machines.retain(|entry| entry.id() != machine.id());
        } else {
            let inspected = inspect_workspace(runner, paths, machine.name())?;
            if inspected.config.pointer("/labels/silo.machine-id").and_then(Value::as_str) != Some(machine.id()) {
                return Err(failure("The sandbox selected for deletion changed ownership. It was preserved."));
            }
        }
    }
    if current.machines.is_empty() && !paths.metadata.exists() { return Ok(()); }
    write_metadata(&paths.metadata, &current)
}

pub(super) fn recover_at_paths(runner: &dyn RuntimeRunner, paths: &RuntimePaths, resources: &HostResources, progress: &dyn Fn(&str, &str, u8)) -> Result<(), RuntimeError> {
    let Some(journal) = load(paths)? else { return Ok(()); };
    let worker = command_lock(paths, MUTATION_TIMEOUT)?;
    reconcile(runner, paths, &journal)?;
    drop(worker);
    save_machine_configuration_with_progress(runner, paths, resources, journal.request, None, progress)?;
    finish(paths)
}

pub(super) fn prepare_retry(runner: &dyn RuntimeRunner, paths: &RuntimePaths) -> Result<(), RuntimeError> {
    if let Some(journal) = load(paths)? {
        let _worker = command_lock(paths, MUTATION_TIMEOUT)?;
        reconcile(runner, paths, &journal)?;
    }
    *RECOVERY_FAILURE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

pub(super) fn pending(paths: &RuntimePaths) -> Result<bool, String> {
    if let Some(message) = RECOVERY_FAILURE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        return Err(message.clone());
    }
    load(paths).map(|journal| journal.is_some()).map_err(|e| e.to_string())
}

pub(crate) fn recover(app: &AppHandle) -> Result<(), String> {
    let result = recover_inner(app);
    *RECOVERY_FAILURE.lock().unwrap_or_else(|e| e.into_inner()) = result.as_ref().err().cloned();
    let _ = app.emit("silo://application-state-changed", ());
    result
}

fn recover_inner(app: &AppHandle) -> Result<(), String> {
    let paths = runtime_paths(app)?;
    if load(&paths).map_err(|e| e.to_string())?.is_none() { return Ok(()); }
    let _guard = MUTATION_LOCK.lock().map_err(|_| "Sandbox configuration lock is unavailable.")?;
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
