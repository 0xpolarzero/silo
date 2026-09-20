//! Workspace discard maintenance. Never deletes guest files or starts a VM.
use super::*;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::sync::atomic::{AtomicUsize, Ordering};

const DAY: u64 = 24 * 60 * 60;
const WEEK: u64 = 7 * DAY;
pub(super) const TRIM_BUDGET: Duration = Duration::from_secs(15);
const STATS: &str = "set -eu; test \"$(findmnt -rn -T /workspace -o TARGET,FSTYPE)\" = '/workspace ext4'; LC_ALL=C df -B1 --output=used,size /workspace | tail -n 1";
// The inner timeout survives a lost host client. No shell expansion of user input.
const TRIM: &str = "set -eu; test \"$(findmnt -rn -T /workspace -o TARGET,FSTYPE)\" = '/workspace ext4'; exec timeout -k 1s \"$1\" fstrim /workspace";
type VerifiedStarts = HashMap<(PathBuf, String), String>;
static VERIFIED_STARTS: OnceLock<Mutex<VerifiedStarts>> = OnceLock::new();

fn verified_starts() -> &'static Mutex<VerifiedStarts> { VERIFIED_STARTS.get_or_init(|| Mutex::new(HashMap::new())) }
fn verified_worker(paths: &RuntimePaths, machine: &MachineConfiguration, observed: &InspectedSandbox) -> bool {
    observed.runtime_instance_id.as_ref().is_some_and(|instance| verified_starts().lock().is_ok_and(|starts|
        starts.get(&(paths.home.clone(), machine.id().into())) == Some(instance)))
}

const HISTORY_LIMIT: usize = 50;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReclaimEntry {
    at: u64,
    trigger: String,
    reclaimed_bytes: Option<u64>,
    error: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    #[serde(default)]
    history: Vec<ReclaimEntry>,
    last_trim_at: Option<u64>,
    last_attempt_at: Option<u64>,
    last_reclaimed_bytes: Option<u64>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageState {
    history: Vec<ReclaimEntry>,
    workspace_host_bytes: u64,
    runtime_host_bytes: u64,
    workspace_used_bytes: Option<u64>,
    workspace_capacity_bytes: Option<u64>,
    last_reclaimed_bytes: Option<u64>,
    last_trim_at: Option<u64>,
    last_error: Option<String>,
}

fn failure(message: &str) -> RuntimeError { RuntimeError::Unavailable(message.into()) }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn record_path(paths: &RuntimePaths, id: &str) -> PathBuf {
    paths.metadata.with_file_name("storage-maintenance").join(format!("{id}.json"))
}
fn load(paths: &RuntimePaths, id: &str) -> Result<Record, RuntimeError> {
    let file = match File::open(record_path(paths, id)) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Record::default()),
        Err(_) => return Err(failure("Storage maintenance history could not be read.")),
    };
    let mut record: Record = serde_json::from_reader(file.take(65536))
        .map_err(|_| failure("Storage maintenance history is invalid; it was preserved."))?;
    if record.history.is_empty() {
        if let Some(at) = record.last_trim_at {
            record.history.push(ReclaimEntry { at, trigger: "legacy".into(), reclaimed_bytes: record.last_reclaimed_bytes, error: None });
        }
    }
    record.history.truncate(HISTORY_LIMIT);
    Ok(record)
}
fn save(paths: &RuntimePaths, id: &str, record: &Record) -> Result<(), RuntimeError> {
    let target = record_path(paths, id);
    let directory = target.parent().unwrap();
    fs::create_dir_all(directory).map_err(|_| failure("Storage maintenance history could not be saved."))?;
    let mut file = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| failure("Storage maintenance history could not be saved."))?;
    serde_json::to_writer(&mut file, record).map_err(|_| failure("Storage maintenance history could not be saved."))?;
    file.as_file().sync_all().map_err(|_| failure("Storage maintenance history could not be synced."))?;
    file.persist(&target).map_err(|_| failure("Storage maintenance history could not be saved."))?;
    File::open(directory).and_then(|file| file.sync_all())
        .map_err(|_| failure("Storage maintenance history could not be synced."))?;
    Ok(())
}

pub(super) fn forget_removed(paths: &RuntimePaths, id: &str) {
    if uuid::Uuid::parse_str(id).is_ok() { let _ = fs::remove_file(record_path(paths, id)); }
    if let Ok(mut starts) = verified_starts().lock() { starts.remove(&(paths.home.clone(), id.into())); }
}
fn due(record: &Record, at: u64, interval: u64) -> bool {
    // Also throttle failures and interrupted attempts: unsupported disks must not
    // be retried every monitor tick or every Quit. Manual requests bypass this.
    record.last_attempt_at.is_none_or(|last| at.saturating_sub(last) >= DAY)
        && record.last_trim_at.is_none_or(|last| at.saturating_sub(last) >= interval)
}
fn machine(paths: &RuntimePaths, id: &str) -> Result<MachineConfiguration, RuntimeError> {
    uuid::Uuid::parse_str(id).map_err(|_| failure("Invalid workspace identity."))?;
    read_metadata(&paths.metadata)?.machines.into_iter()
        .find(|m| m.is_vm() && m.id() == id)
        .ok_or_else(|| failure("Storage maintenance is available only for a configured local VM."))
}
fn verify(machine: &MachineConfiguration, observed: &InspectedSandbox) -> Result<(), RuntimeError> {
    validate_name(machine.name())?;
    ensure_managed(observed)?;
    if observed.name != machine.name()
        || observed.config.pointer("/labels/silo.machine-id").and_then(Value::as_str) != Some(machine.id()) {
        return Err(failure("The workspace identity changed. No storage operation was performed."));
    }
    Ok(())
}
fn workspace_mount(paths: &RuntimePaths, machine: &MachineConfiguration, observed: &InspectedSandbox) -> bool {
    let expected = disk_path(paths, machine.name(), "workspace");
    let matches = |config: &Value| config.get("mounts").and_then(Value::as_array).is_some_and(|mounts| {
        mounts.iter().filter(|m| m["guest"] == WORKSPACE_MOUNT).count() == 1
            && mounts.iter().any(|m| m["guest"] == WORKSPACE_MOUNT && m["type"] == "DiskImage"
                && m["format"] == "Raw" && m["fstype"] == "ext4"
                && m["host"].as_str().is_some_and(|p| Path::new(p) == expected))
    });
    matches(&observed.config) && observed.active_config.as_ref().is_none_or(matches)
}
fn allocated(path: &Path) -> Result<u64, RuntimeError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.blocks().saturating_mul(512)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        _ => Err(failure("The VM disk is not a readable regular file.")),
    }
}
fn guest_args(name: &str, seconds: u64, script: &str) -> Vec<String> {
    vec!["exec".into(), name.into(), "--no-start".into(), "--no-tty".into(),
        "--user".into(), "root".into(), "--timeout".into(), format!("{seconds}s"),
        "--".into(), "sh".into(), "-c".into(), script.into(), "silo-storage".into()]
}
fn stats(output: &str) -> Result<(u64, u64), RuntimeError> {
    let values: Vec<_> = output.split_whitespace().collect();
    if values.len() != 2 { return Err(failure("The guest returned invalid storage measurements.")); }
    let used = values[0].parse::<u64>().map_err(|_| failure("Invalid guest storage usage."))?;
    let capacity = values[1].parse::<u64>().map_err(|_| failure("Invalid guest storage capacity."))?;
    if used > capacity || capacity == 0 { return Err(failure("Invalid guest storage capacity.")); }
    Ok((used, capacity))
}
fn state(runner: &dyn RuntimeRunner, paths: &RuntimePaths, machine: &MachineConfiguration,
    observed: &InspectedSandbox) -> Result<StorageState, RuntimeError> {
    verify(machine, observed)?;
    let record = load(paths, machine.id())?;
    let mut state = StorageState {
        history: record.history,
        workspace_host_bytes: allocated(&disk_path(paths, machine.name(), "workspace"))?,
        runtime_host_bytes: allocated(&paths.home.join("sandboxes").join(machine.name()).join("upper.ext4"))?,
        workspace_used_bytes: None, workspace_capacity_bytes: None,
        last_reclaimed_bytes: record.last_reclaimed_bytes, last_trim_at: record.last_trim_at,
        last_error: record.last_error,
    };
    if observed.status.eq_ignore_ascii_case("running") && !verified_worker(paths, machine, observed) {
        let restart = "Restart this VM in Silo before reclaiming space so it uses the corrected storage runtime.";
        state.last_error = Some(state.last_error.take().map_or_else(|| restart.into(), |error| format!("{error} {restart}")));
    }
    if observed.status.eq_ignore_ascii_case("running") && workspace_mount(paths, machine, observed) {
        match runner.run(paths, &guest_args(machine.name(), 4, STATS), Duration::from_secs(5))
            .and_then(|out| stats(&out.stdout)) {
            Ok((used, capacity)) => { state.workspace_used_bytes = Some(used); state.workspace_capacity_bytes = Some(capacity); }
            Err(_) => { state.last_error.get_or_insert_with(|| "Guest storage usage is unavailable. Refresh after the VM finishes starting.".into()); }
        }
    }
    Ok(state)
}
fn trim(runner: &dyn RuntimeRunner, paths: &RuntimePaths, machine: &MachineConfiguration,
    observed: &InspectedSandbox, budget: Duration, at: u64) -> Result<(), RuntimeError> {
    trim_triggered(runner, paths, machine, observed, budget, at, "manual")
}
fn trim_triggered(runner: &dyn RuntimeRunner, paths: &RuntimePaths, machine: &MachineConfiguration,
    observed: &InspectedSandbox, budget: Duration, at: u64, trigger: &str) -> Result<(), RuntimeError> {
    verify(machine, observed)?;
    if !observed.status.eq_ignore_ascii_case("running") {
        return Err(failure("Start the VM before reclaiming unused workspace space."));
    }
    if !workspace_mount(paths, machine, observed) {
        return Err(failure("The VM does not have the expected workspace disk mounted. No space was reclaimed."));
    }
    if !verified_worker(paths, machine, observed) {
        return Err(failure("Restart this VM in Silo before reclaiming space so it uses the corrected storage runtime."));
    }
    let seconds = budget.as_secs();
    if seconds < 4 { return Err(failure("No time remains for workspace reclamation.")); }
    let _command_guard = configuration_recovery::command_lock(paths, Duration::ZERO)?;
    let disk = fs::OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOFOLLOW)
        .open(disk_path(paths, machine.name(), "workspace"))
        .map_err(|_| failure("The workspace disk could not be opened for reclamation."))?;
    let metadata = disk.metadata().map_err(|_| failure("The workspace disk could not be inspected."))?;
    if !metadata.is_file() { return Err(failure("The workspace disk is not a regular file.")); }
    let before = metadata.blocks().saturating_mul(512);
    let original_length = metadata.len();
    let mut record = load(paths, machine.id())?;
    record.last_attempt_at = Some(at);
    record.last_error = Some("The previous workspace reclamation did not complete.".into());
    record.history.insert(0, ReclaimEntry { at, trigger: trigger.into(), reclaimed_bytes: None, error: record.last_error.clone() });
    record.history.truncate(HISTORY_LIMIT);
    save(paths, machine.id(), &record)?;
    let mut args = guest_args(machine.name(), seconds - 1, TRIM);
    args.push(format!("{}s", seconds - 3));
    let result = runner.run(paths, &args, budget).map(|_| ());
    // Older msb-imago versions truncated a discarded tail. The bundled runtime
    // fixes that upstream; this guard also protects mixed/older installations.
    // Restore only a shortened logical tail, never truncate a growing image.
    let length_result = preserve_length(&disk, original_length);
    let length_error = length_result.as_ref().err().map(ToString::to_string);
    let result = length_result.and(result);
    match result {
        Ok(_) => {
            let after = disk.metadata().map_err(|_| failure("The reclaimed disk could not be measured."))?.blocks().saturating_mul(512);
            record.last_trim_at = Some(now());
            record.last_reclaimed_bytes = Some(before.saturating_sub(after));
            record.last_error = None;
        }
        Err(_) => {
            record.last_error = Some(length_error.unwrap_or_else(|| "Workspace reclamation failed or exceeded its time limit. Your files were preserved; the disk may not support reclamation.".into()));
        }
    }
    record.history[0].error = record.last_error.clone();
    record.history[0].reclaimed_bytes = if result.is_ok() { record.last_reclaimed_bytes } else { None };
    save(paths, machine.id(), &record)?;
    result.map_err(|_| failure(record.last_error.as_deref().unwrap()))
}

fn preserve_length(disk: &File, original_length: u64) -> Result<(), RuntimeError> {
    let length = disk.metadata().map_err(|_| failure("The workspace disk length could not be verified."))?.len();
    if length < original_length {
        disk.set_len(original_length).and_then(|_| disk.sync_all())
            .map_err(|_| failure("The runtime shortened the workspace disk and its length could not be restored. Keep the VM stopped and repair its disk."))?;
        return Err(failure("The runtime shortened the workspace disk; its original length was restored. Update the runtime before reclaiming again."));
    }
    if length != original_length { return Err(failure("The workspace disk size changed during reclamation.")); }
    Ok(())
}

pub(super) fn before_stop(runner: &dyn RuntimeRunner, paths: &RuntimePaths, observed: &InspectedSandbox) {
    automatic(runner, paths, observed, DAY, shutdown::maintenance_budget().min(TRIM_BUDGET));
}

pub(super) fn after_start(runner: &dyn RuntimeRunner, paths: &RuntimePaths, observed: &InspectedSandbox) {
    // Quit may have begun while the bounded start command held the mutation lock.
    // Do not start new maintenance after its shared deadline has expired.
    if shutdown::ensure_accepting_operations().is_err() { return; }
    let Some(id) = observed.config.pointer("/labels/silo.machine-id").and_then(Value::as_str) else { return; };
    let Some(instance) = &observed.runtime_instance_id else { return; };
    if !observed.status.eq_ignore_ascii_case("running") { return; }
    let Ok(machine) = machine(paths, id) else { return; };
    if verify(&machine, observed).is_err() || !workspace_mount(paths, &machine, observed) { return; }
    if !runner.run(paths, &["--silo-storage-protocol".into()], Duration::from_secs(1))
        .is_ok_and(|out| out.stdout.trim() == "1") { return; }
    if let Ok(mut starts) = verified_starts().lock() {
        starts.insert((paths.home.clone(), id.into()), instance.clone());
    }
    automatic(runner, paths, observed, WEEK, shutdown::maintenance_budget().min(TRIM_BUDGET));
}

fn automatic(runner: &dyn RuntimeRunner, paths: &RuntimePaths, observed: &InspectedSandbox, interval: u64, budget: Duration) {
    let Some(id) = observed.config.pointer("/labels/silo.machine-id").and_then(Value::as_str) else { return; };
    let Ok(machine) = machine(paths, id) else { return; };
    let Ok(record) = load(paths, id) else { return; };
    if !due(&record, now(), interval) || !workspace_mount(paths, &machine, observed) { return; }
    // Maintenance failure must never veto stopping a VM.
    let _ = trim_triggered(runner, paths, &machine, observed, budget, now(), if interval == DAY { "beforeStop" } else { "afterStart" });
}

fn periodic(runner: &dyn RuntimeRunner, paths: &RuntimePaths) -> Result<bool, RuntimeError> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let mut machines: Vec<_> = read_metadata(&paths.metadata)?.machines.into_iter().filter(MachineConfiguration::is_vm).collect();
    if machines.is_empty() { return Ok(false); }
    let offset = NEXT.fetch_add(1, Ordering::Relaxed) % machines.len();
    machines.rotate_left(offset);
    let deadline = Instant::now() + TRIM_BUDGET;
    for machine in machines {
        if shutdown::ensure_accepting_operations().is_err() { return Ok(false); }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.as_secs() < 4 { return Ok(false); }
        let Ok(record) = load(paths, machine.id()) else { continue; };
        if !due(&record, now(), WEEK) { continue; }
        let Ok(output) = runner.run(paths, &["inspect".into(), machine.name().into(), "--format".into(), "json".into()], remaining.min(READ_TIMEOUT)) else { continue; };
        let Ok(observed) = serde_json::from_str::<InspectedSandbox>(&output.stdout) else { continue; };
        if verify(&machine, &observed).is_err() || !workspace_mount(paths, &machine, &observed) { continue; }
        if !observed.status.eq_ignore_ascii_case("running") { continue; }
        let budget = deadline.saturating_duration_since(Instant::now()).min(shutdown::maintenance_budget());
        // One VM per tick keeps the global mutation lock available for user actions.
        trim_triggered(runner, paths, &machine, &observed, budget, now(), "scheduled")?;
        return Ok(true);
    }
    Ok(false)
}
pub(crate) fn start_monitor(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        if let Ok(_guard) = MUTATION_LOCK.try_lock() {
            if shutdown::ensure_accepting_operations().is_ok() {
                if let Ok(paths) = runtime_paths(&app) {
                    let _ = periodic(&ProcessRunner, &paths);
                }
            }
        }
        thread::sleep(Duration::from_secs(60));
    });
}

#[tauri::command]
pub async fn read_workspace_storage(app: AppHandle, workspace_id: String) -> Result<StorageState, String> {
    command(app, workspace_id, false).await
}
#[tauri::command]
pub async fn reclaim_workspace_storage(app: AppHandle, workspace_id: String) -> Result<StorageState, String> {
    command(app, workspace_id, true).await
}
async fn command(app: AppHandle, id: String, reclaim: bool) -> Result<StorageState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MUTATION_LOCK.try_lock().map_err(|_| RuntimeError::Busy.to_string())?;
        shutdown::ensure_accepting_operations()?;
        let paths = runtime_paths(&app)?;
        let result = (|| {
            let machine = machine(&paths, &id)?;
            let observed = inspect_workspace(&ProcessRunner, &paths, machine.name())?;
            verify(&machine, &observed)?;
            if reclaim { trim(&ProcessRunner, &paths, &machine, &observed, TRIM_BUDGET, now())?; }
            state(&ProcessRunner, &paths, &machine, &observed)
        })();
        result.map_err(|e| safe_activity_error(&e))
    }).await.map_err(|_| "Storage maintenance worker failed.".to_string())?
}

#[cfg(test)]
mod tests;
