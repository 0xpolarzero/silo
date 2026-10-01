//! Moving a sandbox from the old guest account layout, where agent files live under
//! root, to the unified `silo` working account (UID/GID 1001).
//!
//! This is the host orchestration formerly shipped as
//! `scripts/migrate-working-account.py`, ported so it runs through Silo's runtime
//! plumbing: the operation gate, secret and GitHub transport for the boot, and lifecycle
//! bookkeeping. The account rewrite itself is still the guest payload
//! `guest/migrate-working-account.py`, sent unchanged.
//!
//! The order is the utility's: back up, boot, install missing packages, run the guest
//! payload, stop, and only then save `silo.working-account=1`. The backup is one
//! MicroSandbox disk snapshot of the stopped VM; with the owned workspace volume it holds
//! both the root and `/workspace` disks. It lives in a Silo-owned folder beside the
//! runtime, with `migration.json` recording how far the migration got, so Retry resumes
//! with the same backup. The backup is kept after success.
use super::*;
use std::cell::Cell;
use std::os::unix::fs::DirBuilderExt;

/// Snapshot member name inside the backup.
const MEMBER: &str = "before-account-migration";
const RECORD: &str = "migration.json";
const INSPECTION: &str = "inspect.json";
const SNAPSHOT: &str = "snapshot";
/// Free space kept beyond the backup: the guest copies the home folders on the root disk.
const SPACE_RESERVE: u64 = 2 * 1024 * 1024 * 1024;
/// Guest steps keep the utility's 30-minute limit; the host waits a little longer.
const GUEST_LIMIT: &str = "30m";
const GUEST_TIMEOUT: Duration = Duration::from_secs(31 * 60);
/// Snapshot commands get a base time plus time for their data at a slow-disk rate.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const SNAPSHOT_BYTES_PER_SECOND: u64 = 16 * 1024 * 1024;
/// Shown in the queue as slow after this long; nothing is stopped.
const EXPECTED: Duration = Duration::from_secs(45 * 60);
/// Older images lack the tools the payload and the silo account need.
const PACKAGES: &str = ". /etc/os-release; test \"$ID $VERSION_ID\" = \"ubuntu 24.04\"; \
if ! command -v python3 >/dev/null || ! command -v sudo >/dev/null || ! test -x /usr/lib/openssh/sftp-server; then \
apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 sudo openssh-sftp-server; fi";
const PAYLOAD: &str = include_str!("../../guest/migrate-working-account.py");
const DESKTOP_HELPER: &str = include_str!("../../guest/desktop-service.py");
const INTERRUPTED_BACKUP: &str =
    "Silo closed while backing up this sandbox. Retry to start the migration again.";
const INTERRUPTED: &str =
    "Silo closed during the migration. Retry to continue with the same backup.";

/// Bytes available on the volume holding a path (its nearest existing ancestor).
pub(super) type FreeSpace<'a> = &'a dyn Fn(&Path) -> std::io::Result<u64>;

/// A step of a running migration, shown in the operation queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Checking,
    Stopping,
    BackingUp,
    Starting,
    Installing,
    Migrating,
    Finishing,
}

impl Stage {
    fn label(self) -> &'static str {
        match self {
            Self::Checking => "Checking the sandbox",
            Self::Stopping => "Stopping the sandbox",
            Self::BackingUp => "Backing up the disks",
            Self::Starting => "Starting the sandbox",
            Self::Installing => "Installing required packages",
            Self::Migrating => "Moving files to the silo account",
            Self::Finishing => "Stopping and saving the account setting",
        }
    }

    /// What failed, as the start of a failure message.
    fn failure(self) -> &'static str {
        match self {
            Self::Checking => "Silo could not check the sandbox",
            Self::Stopping => "Silo could not stop the sandbox",
            Self::BackingUp => "Silo could not back up the disks",
            Self::Starting => "Silo could not start the sandbox",
            Self::Installing => "Silo could not install the required packages",
            Self::Migrating => "The account migration inside the sandbox stopped",
            Self::Finishing => "Silo could not finish the migration",
        }
    }

    /// Cancelling is offered only before anything in the sandbox changed: the backup is
    /// then discarded and the sandbox is left as it was, stopped. Once the guest boots
    /// for migration, an interruption would need Retry, so the rest runs to the end.
    pub(super) fn cancellable(self) -> bool {
        matches!(self, Self::Checking | Self::BackingUp)
    }
}

/// The queue label for a migration, with its current step once it runs.
pub(super) fn label(name: &str, stage: Option<Stage>) -> String {
    match stage {
        None => format!("Migrating {name} to the silo account"),
        Some(stage) => format!("Migrating {name} to the silo account: {}", stage.label()),
    }
}

/// How far a migration got, saved in its backup folder.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    /// The backup is being written. The sandbox was at most stopped.
    BackingUp,
    /// The backup is complete; the guest may have changed. Retry resumes from here.
    BackedUp,
    /// The account setting is saved.
    Completed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Failure {
    message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    machine_id: String,
    sandbox: String,
    phase: Phase,
    /// The snapshot directory, relative to the backup folder, once written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<Failure>,
    /// Unix milliseconds of the last change.
    updated_at: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Status {
    /// The sandbox uses the old layout and has no migration in progress.
    Required,
    Running,
    /// The last attempt failed or was interrupted; Retry continues it.
    Failed,
}

/// What the sandbox list shows about a sandbox that still needs migration.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct View {
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    /// Where the backup is, once one was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    backup_directory: Option<String>,
}

/// `Some` for a sandbox that still uses the old account layout.
pub(super) fn required(config: &Value) -> Option<View> {
    crate::working_account::needs_migration(config).then_some(View {
        status: Status::Required,
        stage: None,
        error: None,
        diagnostic: None,
        backup_directory: None,
    })
}

/// The dry run: what would happen, and whether the backup fits.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    sandbox: String,
    running: bool,
    /// An earlier attempt's backup is reused and the migration continues.
    resume: bool,
    steps: Vec<String>,
    backup_directory: String,
    /// Upper bound of the new backup: the disks' allocated host bytes. Zero on resume.
    backup_bytes: u64,
    available_bytes: u64,
    required_bytes: u64,
    enough_space: bool,
    /// The sandbox's memory. Copying the home folders can fill all of it with file cache.
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_bytes: Option<u64>,
    /// Memory this computer has available now, where Silo can measure it (Linux). Below
    /// `memory_bytes`, the host may kill the VM midway; the plan warns but allows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    available_memory_bytes: Option<u64>,
}

/// The result of an attempt that ran. Cancellation is reported as an error instead.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    succeeded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    backup_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
}

fn invalid(message: impl Into<String>) -> RuntimeError {
    RuntimeError::Invalid(message.into())
}

fn unavailable(message: impl Into<String>) -> RuntimeError {
    RuntimeError::Unavailable(message.into())
}

/// Silo-owned parent of every migration backup, beside the runtime it belongs to.
pub(super) fn backups_root(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("account-migration-backups")
}

/// What a candidate backup folder holds for this sandbox.
enum Slot {
    /// Missing or empty: a new backup can go here.
    Free,
    /// This sandbox's unfinished migration: Retry continues with it.
    Current(Record),
    /// A finished backup, or anything else: kept, and never reused.
    Taken,
}

fn slot(directory: &Path, machine: &MachineConfiguration) -> Result<Slot, RuntimeError> {
    let unreadable = || unavailable("Silo could not read its migration backups.");
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Slot::Free),
        Err(_) => return Err(unreadable()),
        Ok(metadata) if !metadata.is_dir() => return Ok(Slot::Taken),
        Ok(_) => {}
    }
    let file = directory.join(RECORD);
    match fs::symlink_metadata(&file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let empty = fs::read_dir(directory)
                .map_err(|_| unreadable())?
                .next()
                .is_none();
            return Ok(if empty { Slot::Free } else { Slot::Taken });
        }
        Err(_) => return Err(unreadable()),
        Ok(metadata) if !metadata.is_file() => return Ok(Slot::Taken),
        Ok(_) => {}
    }
    let bytes = fs::read(&file).map_err(|_| unreadable())?;
    // An unreadable record may be this sandbox's half-finished migration: never skip it.
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| {
        unavailable("The migration progress saved with this sandbox's backup is unreadable. The backup was preserved.")
    })?;
    Ok(
        if record.version == 1
            && record.machine_id == machine.id()
            && record.sandbox == machine.name()
            && record.phase != Phase::Completed
        {
            Slot::Current(record)
        } else {
            Slot::Taken
        },
    )
}

/// This sandbox's backup folder, `<name>-<first ID block>`, and its unfinished
/// migration if any. A finished backup is kept, so a later migration of the same
/// sandbox uses the next free `-2`, `-3`… folder instead.
fn locate(
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(PathBuf, Option<Record>), RuntimeError> {
    let short = machine.id().split('-').next().unwrap_or_default();
    let base = format!("{}-{short}", machine.name());
    for index in 1..=100 {
        let name = if index == 1 {
            base.clone()
        } else {
            format!("{base}-{index}")
        };
        let directory = backups_root(paths).join(name);
        match slot(&directory, machine)? {
            Slot::Free => return Ok((directory, None)),
            Slot::Current(record) => return Ok((directory, Some(record))),
            Slot::Taken => {}
        }
    }
    Err(unavailable(
        "Too many migration backups of this sandbox are kept. Remove old ones, then retry.",
    ))
}

/// Replace a private file atomically.
fn write_private(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), RuntimeError> {
    let failed = || unavailable("Silo could not save the migration progress in its backup folder.");
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| failed())?;
    file.write_all(bytes).map_err(|_| failed())?;
    file.as_file().sync_all().map_err(|_| failed())?;
    file.persist(directory.join(name)).map_err(|_| failed())?;
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| failed())
}

fn save(directory: &Path, record: &mut Record) -> Result<(), RuntimeError> {
    record.updated_at = activity_timestamp();
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|_| unavailable("Silo could not encode the migration progress."))?;
    write_private(directory, RECORD, &bytes)
}

/// The recorded snapshot directory, which must stay inside the backup folder.
fn snapshot_path(directory: &Path, record: &Record) -> Result<PathBuf, RuntimeError> {
    let relative = Path::new(record.snapshot.as_deref().unwrap_or_default());
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(unavailable(
            "The backup has no valid snapshot record. Keep its folder and do not relabel the sandbox by hand.",
        ));
    }
    let path = directory.join(relative);
    if !path.join("snapshot.json").is_file() {
        return Err(unavailable(
            "The backup snapshot is missing. Keep its folder and do not relabel the sandbox by hand.",
        ));
    }
    Ok(path)
}

/// The one snapshot MicroSandbox wrote under `<backup>/snapshot/<group>/`.
fn find_snapshot(directory: &Path) -> Result<String, RuntimeError> {
    let missing = || unavailable("The backup snapshot could not be found after it was created.");
    let mut found = Vec::new();
    for group in fs::read_dir(directory.join(SNAPSHOT)).map_err(|_| missing())? {
        let group = group.map_err(|_| missing())?.path();
        if !fs::symlink_metadata(&group).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        for member in fs::read_dir(&group).map_err(|_| missing())? {
            let member = member.map_err(|_| missing())?.path();
            let hidden = member
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'));
            if !hidden
                && fs::symlink_metadata(&member).is_ok_and(|metadata| metadata.is_dir())
                && member.join("snapshot.json").is_file()
            {
                found.push(member);
            }
        }
    }
    let [snapshot] = found.as_slice() else {
        return Err(unavailable(
            "The backup must contain exactly one snapshot. The folder was preserved.",
        ));
    };
    snapshot
        .strip_prefix(directory)
        .ok()
        .and_then(Path::to_str)
        .map(str::to_owned)
        .ok_or_else(missing)
}

/// Port of the utility's `inspect_legacy`, for the owned workspace volume Silo uses now.
fn check_legacy(
    inspected: &InspectedSandbox,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    ensure_managed(inspected)?;
    if inspected.name != machine.name()
        || inspected
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(machine.id())
    {
        return Err(invalid(
            "The sandbox identity changed. Nothing was migrated.",
        ));
    }
    match inspected.config.get("labels").and_then(|labels| labels.get(crate::working_account::LABEL)) {
        None => {}
        Some(Value::String(version)) if version == "1" => {
            return Err(invalid(format!("{} already uses the silo account.", machine.name())))
        }
        Some(_) => {
            return Err(invalid(
                "This sandbox uses an account layout this version of Silo cannot migrate. Update Silo first.",
            ))
        }
    }
    let mounts: Vec<&Value> = inspected
        .config
        .get("mounts")
        .and_then(Value::as_array)
        .map(|mounts| {
            mounts
                .iter()
                .filter(|mount| mount["type"] != "Tmpfs")
                .collect()
        })
        .unwrap_or_default();
    let standard = matches!(mounts.as_slice(), [mount]
        if mount["guest"] == WORKSPACE_MOUNT
            && mount["type"] == "Owned"
            && mount.pointer("/storage/kind").and_then(Value::as_str) == Some("disk"));
    if !standard {
        return Err(invalid(
            "Migration needs the standard Silo workspace disk. This sandbox has other storage, so nothing was changed.",
        ));
    }
    if !matches!(
        inspected.status.as_str(),
        "Running" | "Stopped" | "Created" | "Crashed"
    ) {
        return Err(invalid(format!(
            "{} is {}. Wait until it is running or stopped, then retry.",
            machine.name(),
            inspected.status.to_ascii_lowercase()
        )));
    }
    Ok(())
}

/// The bundled runtime can open the silo account, and the VM is a standard old one.
fn check(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<InspectedSandbox, RuntimeError> {
    let probe = runner.run(
        paths,
        &["--silo-working-account-protocol".into()],
        READ_TIMEOUT,
    );
    if !probe.is_ok_and(|output| output.stdout.trim() == "1") {
        return Err(unavailable(
            "The bundled runtime cannot open the silo account. Relaunch Silo to rerun system checks, then repair or update Silo.",
        ));
    }
    if checkpoints::needs_explicit_start(paths, machine.id())? {
        return Err(invalid(format!(
            "{} is waiting to restore a checkpoint. Finish or abandon the restore before migrating it.",
            machine.name()
        )));
    }
    let inspected = inspect_workspace(runner, paths, machine.name())?;
    check_legacy(&inspected, machine)?;
    Ok(inspected)
}

fn steps(name: &str, running: bool, resume: bool) -> Vec<String> {
    let mut steps = Vec::new();
    if running {
        steps.push(format!(
            "Stop {name}. Its terminals, editors and desktop disconnect."
        ));
    }
    steps.push(if resume {
        "Keep the earlier backup and continue from where the last attempt stopped.".into()
    } else {
        "Back up the root and workspace disks to the backup folder.".into()
    });
    steps.push(format!(
        "Start {name} and install Python, sudo and the SFTP server if they are missing. This needs network access."
    ));
    steps.push("Copy the root and desktop home folders into /home/silo, give the silo account (UID/GID 1001) ownership of /workspace, and install passwordless sudo for it. The original home folders stay in place.".into());
    steps.push(format!(
        "Verify the account, stop {name}, and switch Silo to the silo account. {name} stays stopped."
    ));
    steps
}

pub(super) fn plan_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    free_space: FreeSpace<'_>,
) -> Result<Plan, RuntimeError> {
    let inspected = check(runner, paths, machine)?;
    let (directory, record) = locate(paths, machine)?;
    let resume = record.is_some_and(|record| record.phase == Phase::BackedUp);
    let backup_bytes = if resume {
        0
    } else {
        storage::disks_host_bytes(paths, machine)?
    };
    let available_bytes = free_space(&directory)
        .map_err(|_| unavailable("Silo could not check the free space for the backup."))?;
    let required_bytes = backup_bytes.saturating_add(SPACE_RESERVE);
    Ok(Plan {
        sandbox: machine.name().into(),
        running: inspected.status == "Running",
        resume,
        steps: steps(machine.name(), inspected.status == "Running", resume),
        backup_directory: directory.display().to_string(),
        backup_bytes,
        available_bytes,
        required_bytes,
        enough_space: available_bytes >= required_bytes,
        memory_bytes: inspected
            .config
            .pointer("/resources/memory_mib")
            .and_then(Value::as_u64)
            .and_then(|mib| mib.checked_mul(1024 * 1024)),
        available_memory_bytes: None,
    })
}

/// Memory available to new work on this computer, where the kernel reports it.
#[cfg(target_os = "linux")]
fn available_memory() -> Option<u64> {
    mem_available(&fs::read_to_string("/proc/meminfo").ok()?)
}

/// macOS compresses and swaps memory instead of killing a VM when it runs short.
#[cfg(not(target_os = "linux"))]
fn available_memory() -> Option<u64> {
    None
}

/// `MemAvailable` from `/proc/meminfo`, in bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn mem_available(meminfo: &str) -> Option<u64> {
    meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemAvailable:"))?
        .trim()
        .strip_suffix("kB")?
        .trim()
        .parse::<u64>()
        .ok()?
        .checked_mul(1024)
}

// Failure summaries redact words containing `/`, so messages never embed paths;
// the backup folder travels in its own field instead.
fn not_enough_space(required: u64, available: u64) -> RuntimeError {
    invalid(format!(
        "Not enough free space for the backup: it needs about {} and {} is available on the disk that holds Silo's data. Free up space, then retry. Nothing was changed.",
        crate::backup::format_bytes(required),
        crate::backup::format_bytes(available),
    ))
}

/// Create the backup folder, private, or reuse the one `locate` chose: empty, or left
/// by an interrupted backup of this sandbox.
fn prepare_directory(directory: &Path) -> Result<(), RuntimeError> {
    let failed = || unavailable("Silo could not create the backup folder.");
    fs::create_dir_all(directory.parent().ok_or_else(failed)?).map_err(|_| failed())?;
    match fs::symlink_metadata(directory) {
        // An interrupted backup is incomplete: only its snapshot is replaced.
        Ok(metadata) if metadata.is_dir() => remove_snapshot(directory),
        Ok(_) => Err(failed()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::DirBuilder::new()
            .mode(0o700)
            .create(directory)
            .map_err(|_| failed()),
        Err(_) => Err(failed()),
    }
}

/// Remove an incomplete snapshot, which holds a partial copy of the disks.
fn remove_snapshot(directory: &Path) -> Result<(), RuntimeError> {
    match fs::remove_dir_all(directory.join(SNAPSHOT)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(unavailable(
            "Silo could not remove an incomplete backup. Remove its snapshot folder, then retry.",
        )),
    }
}

/// Stop and wait until the runtime reports the sandbox stopped. Never cancelled midway.
fn stop(runner: &dyn RuntimeRunner, paths: &RuntimePaths, name: &str) -> Result<(), RuntimeError> {
    operation_gate::uncancellable(|| {
        let result = runner.run(
            paths,
            &["stop".into(), name.into(), "--quiet".into()],
            STOP_TIMEOUT,
        );
        let deadline = Instant::now() + MUTATION_TIMEOUT;
        let mut observed = inspect_workspace(runner, paths, name)?;
        while matches!(
            observed.status.as_str(),
            "Starting" | "Stopping" | "Draining"
        ) && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(250));
            observed = inspect_workspace(runner, paths, name)?;
        }
        if matches!(observed.status.as_str(), "Stopped" | "Created" | "Crashed") {
            let _ = crate::secrets::workspace_stopped(name);
            return Ok(());
        }
        result?;
        Err(unavailable(format!(
            "{name} did not stop. Check its status, then retry."
        )))
    })
}

/// MicroSandbox makes each capture the parent of the sandbox's next one, and Silo's
/// exports carry that ancestry (`snapshot save --with-parents`). A migration backup must
/// stay out of it: otherwise every later export would include the backup, and deleting
/// the backup would make those exports fail. MicroSandbox has no capture option for this,
/// so the ancestry cursor it keeps beside the sandbox is put back after the backup. Silo
/// holds the VM's lane meanwhile, so no other capture of this VM can run.
struct Ancestry {
    path: PathBuf,
    before: Option<Vec<u8>>,
}

impl Ancestry {
    fn read(paths: &RuntimePaths, name: &str) -> Result<Self, RuntimeError> {
        let path = paths
            .home
            .join("sandboxes")
            .join(name)
            .join("snapshot-lineage.json");
        let before = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                return Err(unavailable(
                    "Silo could not read the sandbox's snapshot history.",
                ))
            }
        };
        Ok(Self { path, before })
    }

    fn restore(&self) -> Result<(), RuntimeError> {
        let failed = || {
            unavailable("Silo could not keep the backup out of the sandbox's snapshot history. Keep the backup: later exports of this sandbox include it.")
        };
        match &self.before {
            None => match fs::remove_file(&self.path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(failed()),
                _ => Ok(()),
            },
            Some(bytes) => {
                let directory = self.path.parent().ok_or_else(failed)?;
                let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| failed())?;
                file.write_all(bytes).map_err(|_| failed())?;
                file.as_file().sync_all().map_err(|_| failed())?;
                file.persist(&self.path).map_err(|_| failed())?;
                Ok(())
            }
        }
    }
}

/// Capture both disks of the stopped VM into the backup folder, outside the sandbox's
/// snapshot history. Returns the snapshot's path relative to the folder, and whether
/// the history was put back; a backup whose history could not be put back is still
/// kept, because later captures now build on it.
fn back_up(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    directory: &Path,
    bytes: u64,
) -> Result<(String, Result<(), RuntimeError>), RuntimeError> {
    remove_snapshot(directory)?;
    let destination = directory.join(SNAPSHOT);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&destination)
        .map_err(|_| unavailable("Silo could not create the backup folder."))?;
    let timeout = SNAPSHOT_TIMEOUT + Duration::from_secs(bytes / SNAPSHOT_BYTES_PER_SECOND);
    let ancestry = Ancestry::read(paths, machine.name())?;
    // Stopped disk capture: the root disk and the owned workspace volume, with integrity.
    let created = runner.run(
        paths,
        &[
            "snapshot".into(),
            "create".into(),
            "--from-sandbox".into(),
            machine.name().into(),
            "--dest-dir".into(),
            destination.display().to_string(),
            MEMBER.into(),
            "--integrity".into(),
        ],
        timeout,
    );
    // Also after a failed or cancelled capture, which may have published before it ended.
    let kept_out = operation_gate::uncancellable(|| ancestry.restore());
    match created {
        Ok(_) => Ok((find_snapshot(directory)?, kept_out)),
        Err(error) => {
            kept_out?;
            Err(error)
        }
    }
}

fn guest(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    command: &[&str],
) -> Result<CommandOutput, RuntimeError> {
    let mut args: Vec<String> = [
        "exec",
        name,
        "--no-start",
        "--no-tty",
        "--timeout",
        GUEST_LIMIT,
        "--user",
        "root",
        "--",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    args.extend(command.iter().map(|argument| (*argument).to_owned()));
    runner.run(paths, &args, GUEST_TIMEOUT)
}

/// Boot, run the package step and the payload, and always stop again.
fn migrate_guest(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    resume: bool,
    progress: &dyn Fn(Stage),
    reached: &Reached,
) -> Result<(), RuntimeError> {
    let stage = &reached.stage;
    let enter = |next: Stage| {
        stage.set(next);
        progress(next);
    };
    crash_acknowledgement::clear(paths, name)?;
    let booted = runner.run(
        paths,
        &["start".into(), name.into(), "--quiet".into()],
        MUTATION_TIMEOUT,
    );
    let result = booted.and_then(|_| {
        enter(Stage::Installing);
        guest(runner, paths, name, &["/bin/sh", "-ec", PACKAGES])?;
        enter(Stage::Migrating);
        let mut payload = vec!["python3", "-c", PAYLOAD, DESKTOP_HELPER];
        if resume {
            payload.push("--resume");
        }
        guest(runner, paths, name, &payload).map(drop)
    });
    let failed = stage.get();
    // A VM that died under a guest command, for example killed when the host ran out of
    // memory, is reported as such rather than as the command's failure.
    if result.is_err() && matches!(failed, Stage::Installing | Stage::Migrating) {
        reached.crashed.set(
            inspect_workspace(runner, paths, name)
                .is_ok_and(|observed| observed.status == "Crashed"),
        );
    }
    enter(Stage::Finishing);
    let stopped = stop(runner, paths, name);
    match (result, stopped) {
        (Err(error), _) => {
            stage.set(failed);
            Err(error)
        }
        (Ok(()), stopped) => stopped,
    }
}

/// Save `silo.working-account=1` and check that the runtime kept it.
fn publish_label(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Result<(), RuntimeError> {
    runner.run(
        paths,
        &[
            "modify".into(),
            name.into(),
            "--label".into(),
            crate::working_account::UNIFIED_LABEL.into(),
        ],
        MUTATION_TIMEOUT,
    )?;
    let verified = inspect_workspace(runner, paths, name)?;
    if verified
        .config
        .get("labels")
        .and_then(|labels| labels.get(crate::working_account::LABEL))
        .and_then(Value::as_str)
        != Some("1")
    {
        return Err(unavailable(
            "The sandbox was migrated, but its account setting was not saved. Retry to save it.",
        ));
    }
    Ok(())
}

/// The last `SomethingError: message` line a Python traceback ends with.
fn guest_reason(detail: &str) -> Option<String> {
    let line = detail
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let (kind, message) = line.split_once(": ")?;
    let kind = kind.rsplit('.').next().unwrap_or(kind);
    (kind.ends_with("Error") || kind.ends_with("Exception"))
        .then(|| message.trim().chars().take(400).collect::<String>())
        .filter(|message| !message.is_empty())
}

/// How far an attempt got: its step, and whether the VM crashed during a guest command.
struct Reached {
    stage: Cell<Stage>,
    crashed: Cell<bool>,
}

/// The message and Details of a failure where the attempt `reached`.
fn describe(reached: &Reached, error: &RuntimeError) -> Failure {
    let stage = reached.stage.get();
    let report = failure_report(error);
    let message = match error {
        _ if reached.crashed.get() => "The sandbox stopped unexpectedly during the migration. This computer may have run out of memory: stop other sandboxes, then retry.".into(),
        RuntimeError::Failed { detail, .. } => {
            let reason = guest_reason(detail)
                .filter(|_| matches!(stage, Stage::Installing | Stage::Migrating))
                .unwrap_or_else(|| failure_reason(failure_category(detail)).into());
            format!("{}: {reason}", stage.failure())
        }
        RuntimeError::TimedOut { .. } => format!("{}: it did not finish in time.", stage.failure()),
        _ => report.summary,
    };
    Failure {
        message,
        diagnostic: report.diagnostic,
    }
}

/// A failed attempt: the error, and its message and Details for the user.
#[derive(Debug)]
pub(super) struct Failed {
    pub(super) error: RuntimeError,
    pub(super) failure: Failure,
}

/// Migrate one sandbox. The caller holds its lane in the operation gate. Returns the
/// backup folder. `progress` reports each step; a failure is saved with the backup.
pub(super) fn migrate_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    free_space: FreeSpace<'_>,
    progress: &dyn Fn(Stage),
) -> Result<PathBuf, Failed> {
    let reached = Reached {
        stage: Cell::new(Stage::Checking),
        crashed: Cell::new(false),
    };
    attempt(runner, paths, machine, free_space, progress, &reached).map_err(|error| Failed {
        failure: describe(&reached, &error),
        error,
    })
}

fn attempt(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    free_space: FreeSpace<'_>,
    progress: &dyn Fn(Stage),
    reached: &Reached,
) -> Result<PathBuf, RuntimeError> {
    let stage = &reached.stage;
    progress(Stage::Checking);
    let inspected = check(runner, paths, machine)?;
    let (directory, existing) = locate(paths, machine)?;
    let resume = existing
        .as_ref()
        .is_some_and(|record| record.phase == Phase::BackedUp);
    let bytes = if resume {
        0
    } else {
        storage::disks_host_bytes(paths, machine)?
    };
    let available = free_space(&directory)
        .map_err(|_| unavailable("Silo could not check the free space for the backup."))?;
    let required = bytes.saturating_add(SPACE_RESERVE);
    if available < required {
        return Err(not_enough_space(required, available));
    }
    let mut record = match existing {
        Some(record) if resume => {
            let snapshot = snapshot_path(&directory, &record)?;
            runner
                .run(
                    paths,
                    &["snapshot".into(), "verify".into(), snapshot.display().to_string()],
                    SNAPSHOT_TIMEOUT,
                )
                .map_err(|_| {
                    unavailable(
                        "The backup failed its integrity check. Keep its folder and do not relabel the sandbox by hand.",
                    )
                })?;
            record
        }
        _ => {
            prepare_directory(&directory)?;
            let mut record = Record {
                version: 1,
                machine_id: machine.id().into(),
                sandbox: machine.name().into(),
                phase: Phase::BackingUp,
                snapshot: None,
                failure: None,
                updated_at: 0,
            };
            save(&directory, &mut record)?;
            record
        }
    };
    let enter = |next: Stage| {
        stage.set(next);
        progress(next);
    };
    let result = (|| -> Result<(), RuntimeError> {
        if inspected.status == "Running" {
            enter(Stage::Stopping);
            stop(runner, paths, machine.name())?;
        }
        if !resume {
            enter(Stage::BackingUp);
            let (snapshot, kept_out) = back_up(runner, paths, machine, &directory, bytes)?;
            let inspection = serde_json::json!({
                "name": inspected.name,
                "status": inspected.status,
                "config": inspected.config,
            });
            write_private(
                &directory,
                INSPECTION,
                &serde_json::to_vec_pretty(&inspection).unwrap_or_default(),
            )?;
            record.phase = Phase::BackedUp;
            record.snapshot = Some(snapshot);
            record.failure = None;
            save(&directory, &mut record)?;
            kept_out?;
        }
        enter(Stage::Starting);
        // Past this point the guest changes; a cancel that arrived earlier ends here.
        operation_gate::check_cancelled().map_err(|_| RuntimeError::Cancelled {
            operation: label(machine.name(), None),
        })?;
        migrate_guest(runner, paths, machine.name(), resume, progress, reached)?;
        // Never advertise the new account until guest verification and a clean stop.
        operation_gate::uncancellable(|| publish_label(runner, paths, machine.name()))
    })();
    match result {
        Ok(()) => {
            record.phase = Phase::Completed;
            record.failure = None;
            save(&directory, &mut record)?;
            Ok(directory)
        }
        // Cancelled before the guest changed: nothing to keep but a stopped sandbox.
        Err(error @ RuntimeError::Cancelled { .. }) if !resume => {
            let _ = fs::remove_dir_all(&directory);
            Err(error)
        }
        Err(error @ RuntimeError::Cancelled { .. }) => Err(error),
        Err(error) => {
            if record.phase == Phase::BackingUp {
                let _ = remove_snapshot(&directory);
            }
            record.failure = Some(describe(reached, &error));
            // The failure is what matters; a failed save leaves the earlier record.
            let _ = save(&directory, &mut record);
            Err(error)
        }
    }
}

type Running = HashMap<(PathBuf, String), Stage>;
static RUNNING: OnceLock<Mutex<Running>> = OnceLock::new();

fn running() -> std::sync::MutexGuard<'static, Running> {
    RUNNING
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Marks a migration as running for the sandbox list until dropped.
struct RunningMigration {
    key: (PathBuf, String),
}

impl RunningMigration {
    fn start(paths: &RuntimePaths, id: &str) -> Self {
        let key = (paths.metadata.clone(), id.to_owned());
        running().insert(key.clone(), Stage::Checking);
        Self { key }
    }

    fn set(&self, stage: Stage) {
        running().insert(self.key.clone(), stage);
    }
}

impl Drop for RunningMigration {
    fn drop(&mut self) {
        running().remove(&self.key);
    }
}

/// Fill in a running or failed migration for a VM row. Rows without the old layout
/// are left alone unless a migration is running for them.
pub(super) fn annotate(
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    view: &mut Option<View>,
) {
    let located = locate(paths, machine);
    if let Some(stage) = running()
        .get(&(paths.metadata.clone(), machine.id().to_owned()))
        .copied()
    {
        *view = Some(View {
            status: Status::Running,
            stage: Some(stage.label().into()),
            error: None,
            diagnostic: None,
            backup_directory: located
                .ok()
                .map(|(directory, _)| directory.display().to_string()),
        });
        return;
    }
    let Some(view) = view.as_mut() else {
        return;
    };
    match located {
        Ok((directory, Some(record))) => {
            let interrupted = if record.phase == Phase::BackingUp {
                INTERRUPTED_BACKUP
            } else {
                INTERRUPTED
            };
            let failure = record.failure.unwrap_or(Failure {
                message: interrupted.into(),
                diagnostic: None,
            });
            view.status = Status::Failed;
            view.error = Some(failure.message);
            view.diagnostic = failure.diagnostic;
            view.backup_directory =
                (record.phase == Phase::BackedUp).then(|| directory.display().to_string());
        }
        Ok(_) => {}
        Err(error) => {
            view.status = Status::Failed;
            view.error = Some(error.to_string());
        }
    }
}

fn configured(paths: &RuntimePaths, id: &str) -> Result<MachineConfiguration, RuntimeError> {
    uuid::Uuid::parse_str(id).map_err(|_| invalid("Silo could not identify this sandbox."))?;
    read_metadata(&paths.metadata)?
        .machines
        .into_iter()
        .find(|machine| machine.is_vm() && machine.id() == id)
        .ok_or_else(|| invalid("This sandbox is not a local VM on this computer."))
}

fn plan_local(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    id: &str,
) -> Result<Plan, RuntimeError> {
    let machine = configured(paths, id)?;
    let mut plan = plan_with(runner, paths, &machine, &crate::backup::available_bytes)?;
    plan.available_memory_bytes = available_memory();
    Ok(plan)
}

/// Run one migration in the VM's lane of the operation gate. Only admission errors and
/// cancellation are errors; an attempt that ran reports its outcome.
fn run_local(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    id: &str,
    changed: &dyn Fn(),
) -> Result<Outcome, RuntimeError> {
    let machine = configured(paths, id)?;
    let name = machine.name().to_owned();
    let guard = OPERATIONS
        .kind(operation_gate::OperationKind::AccountMigration)
        .acquire(
            operation_gate::Scope::Vm { id: id.to_owned() },
            Some(name.clone()),
            &label(&name, None),
            Some(format!("vm:{id}:account-migration")),
        )?;
    guard.allow_cancel();
    guard.expect_within(EXPECTED);
    shutdown::ensure_accepting_operations().map_err(RuntimeError::Unavailable)?;
    // The sandbox may have been deleted or replaced while this waited its turn.
    let machine = configured(paths, id)?;
    let marker = RunningMigration::start(paths, id);
    // Migration owns this VM's lifecycle now and leaves it stopped: a saved Start from
    // before (refused for the old layout) must not resume later, nor keep its error.
    lifecycle_recovery::retire_for(paths, &machine)?;
    let _ = runtime_activity::acknowledge_failure(paths, id);
    changed();
    let result = migrate_with(
        runner,
        paths,
        &machine,
        &crate::backup::available_bytes,
        &|stage| {
            if stage.cancellable() {
                guard.allow_cancel();
            } else {
                guard.forbid_cancel();
            }
            guard.relabel(&label(&name, Some(stage)));
            marker.set(stage);
            changed();
        },
    );
    drop(marker);
    drop(guard);
    match result {
        Ok(directory) => Ok(Outcome {
            succeeded: true,
            backup_directory: Some(directory.display().to_string()),
            error: None,
            diagnostic: None,
        }),
        Err(Failed {
            error: error @ (RuntimeError::Cancelled { .. } | RuntimeError::Admission(_)),
            ..
        }) => Err(error),
        Err(Failed { failure, .. }) => Ok(Outcome {
            succeeded: false,
            // A failure after the backup was complete keeps it for Retry.
            backup_directory: locate(paths, &machine)
                .ok()
                .filter(|(_, record)| {
                    record
                        .as_ref()
                        .is_some_and(|record| record.phase == Phase::BackedUp)
                })
                .map(|(directory, _)| directory.display().to_string()),
            error: Some(failure.message),
            diagnostic: failure.diagnostic,
        }),
    }
}

#[tauri::command]
pub async fn plan_account_migration(
    app: AppHandle,
    workspace_id: String,
) -> Result<Plan, BridgeError> {
    crate::runtime_migration::ensure_ready(&app)?;
    operation_gate::spawn_blocking(move || {
        let paths = runtime_paths(&app)?;
        plan_local(&ProcessRunner, &paths, &workspace_id).map_err(BridgeError::from)
    })
    .await
    .map_err(|_| BridgeError::from(internal_failure("checking the sandbox for migration")))?
}

#[tauri::command]
pub async fn migrate_account(app: AppHandle, workspace_id: String) -> Result<Outcome, BridgeError> {
    crate::runtime_migration::ensure_ready(&app)?;
    shutdown::ensure_accepting_operations()?;
    operation_gate::spawn_blocking(move || {
        let paths = runtime_paths(&app)?;
        let changed = || {
            let _ = app.emit("silo://application-state-changed", ());
        };
        let result = run_local(&ProcessRunner, &paths, &workspace_id, &changed);
        changed();
        result.map_err(BridgeError::from)
    })
    .await
    .map_err(|_| BridgeError::from(internal_failure("migrating the sandbox")))?
}

/// Bridge methods for a controlling computer: `runtime.account.plan` and
/// `runtime.account.migrate`, both naming the VM by `vmId`.
pub(super) fn dispatch_remote(
    app: &AppHandle,
    paths: &RuntimePaths,
    method: &str,
    params: &Value,
) -> Result<Value, BridgeError> {
    let id = params["vmId"].as_str().ok_or("Missing VM identity.")?;
    let value = match method {
        "runtime.account.plan" => serde_json::to_value(plan_local(&ProcessRunner, paths, id)?),
        "runtime.account.migrate" => {
            let changed = || {
                let _ = app.emit("silo://application-state-changed", ());
            };
            let result = run_local(&ProcessRunner, paths, id, &changed);
            changed();
            serde_json::to_value(result?)
        }
        _ => return Err(BridgeError::unsupported()),
    };
    value.map_err(|error| BridgeError::from(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const ID: &str = "3f2a1b4c-0000-4000-8000-000000000001";

    /// A runtime whose sandbox state the test controls.
    struct Fake {
        status: RefCell<String>,
        labels: RefCell<serde_json::Map<String, Value>>,
        mounts: RefCell<Value>,
        calls: RefCell<Vec<Vec<String>>>,
        /// Fails the first command starting with these arguments, with this result.
        fail: RefCell<Option<(Vec<String>, RuntimeError)>>,
    }

    impl Fake {
        fn new(status: &str) -> Self {
            let labels = json!({"silo.managed":"true","silo.machine-id":ID});
            Self {
                status: RefCell::new(status.into()),
                labels: RefCell::new(labels.as_object().unwrap().clone()),
                mounts: RefCell::new(json!([
                    {"type":"Tmpfs","guest":"/tmp"},
                    {"type":"Owned","guest":"/workspace","storage":{"kind":"disk","capacity_mib":1024}}
                ])),
                calls: RefCell::new(Vec::new()),
                fail: RefCell::new(None),
            }
        }

        fn fail_on(&self, prefix: &[&str], error: RuntimeError) {
            *self.fail.borrow_mut() = Some((
                prefix.iter().map(|part| (*part).to_owned()).collect(),
                error,
            ));
        }

        fn commands(&self) -> Vec<String> {
            self.calls
                .borrow()
                .iter()
                .map(|call| match call[0].as_str() {
                    "snapshot" | "exec" => format!("{} {}", call[0], call[1]),
                    other => other.to_owned(),
                })
                .collect()
        }

        fn guest_commands(&self) -> Vec<Vec<String>> {
            self.calls
                .borrow()
                .iter()
                .filter(|call| call[0] == "exec")
                .map(|call| {
                    call.iter()
                        .skip_while(|part| *part != "--")
                        .skip(1)
                        .cloned()
                        .collect()
                })
                .collect()
        }
    }

    impl RuntimeRunner for Fake {
        fn run(
            &self,
            _: &RuntimePaths,
            args: &[String],
            _: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            self.calls.borrow_mut().push(args.to_vec());
            let failing = self
                .fail
                .borrow()
                .as_ref()
                .is_some_and(|(prefix, _)| args.starts_with(prefix));
            if failing {
                return Err(self.fail.borrow_mut().take().unwrap().1);
            }
            let ok = |stdout: String| {
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            };
            match args[0].as_str() {
                "--silo-working-account-protocol" => ok("1\n".into()),
                "inspect" => ok(json!({
                    "name": args[1],
                    "status": self.status.borrow().clone(),
                    "config": {"labels": self.labels.borrow().clone(), "mounts": self.mounts.borrow().clone(), "resources": {"memory_mib": 12288}},
                })
                .to_string()),
                "stop" => {
                    *self.status.borrow_mut() = "Stopped".into();
                    ok(String::new())
                }
                "start" => {
                    *self.status.borrow_mut() = "Running".into();
                    ok(String::new())
                }
                "snapshot" if args[1] == "create" => {
                    let destination = PathBuf::from(&args[args.iter().position(|arg| arg == "--dest-dir").unwrap() + 1]);
                    let member = destination.join("dev/snap_0123");
                    fs::create_dir_all(&member).unwrap();
                    fs::write(member.join("snapshot.json"), "{}").unwrap();
                    fs::write(destination.join("dev/group.json"), "{}").unwrap();
                    // Like MicroSandbox, make the capture the sandbox's next parent.
                    let home = destination.ancestors().nth(3).unwrap().join("home");
                    fs::write(home.join("sandboxes/dev/snapshot-lineage.json"), r#"{"snapshot_id":"snap_0123"}"#).unwrap();
                    ok(String::new())
                }
                "modify" => {
                    let (key, value) = args[3].split_once('=').unwrap();
                    self.labels.borrow_mut().insert(key.into(), value.into());
                    ok(String::new())
                }
                _ => ok(String::new()),
            }
        }
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        paths: RuntimePaths,
        machine: MachineConfiguration,
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let paths = crate::test_support::paths(directory.path());
        let machine = MachineConfiguration::Vm {
            id: ID.into(),
            name: "dev".into(),
            cpus: 1,
            max_cpus: 1,
            memory_gib: 1,
            max_memory_gib: 1,
            workspace_storage_gib: 1,
            runtime_storage_gib: 1,
            desktop: None,
        };
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine.clone()],
            },
        )
        .unwrap();
        let sandbox = paths.home.join("sandboxes/dev");
        let volume = storage::workspace_disk_dir(&paths, &machine);
        fs::create_dir_all(&volume).unwrap();
        fs::write(sandbox.join("upper.ext4"), vec![7u8; 8192]).unwrap();
        fs::write(volume.join("disk.raw"), vec![9u8; 8192]).unwrap();
        Fixture {
            _directory: directory,
            paths,
            machine,
        }
    }

    fn plenty(_: &Path) -> std::io::Result<u64> {
        Ok(100 * 1024 * 1024 * 1024)
    }

    fn scarce(_: &Path) -> std::io::Result<u64> {
        Ok(SPACE_RESERVE)
    }

    fn migrate(
        fake: &Fake,
        fixture: &Fixture,
        stages: &RefCell<Vec<Stage>>,
    ) -> Result<PathBuf, Failed> {
        migrate_with(fake, &fixture.paths, &fixture.machine, &plenty, &|stage| {
            stages.borrow_mut().push(stage)
        })
    }

    fn guest_failure(message: &str) -> RuntimeError {
        RuntimeError::Failed {
            operation: "The sandbox operation".into(),
            exit_code: Some(1),
            detail: format!("Traceback (most recent call last):\n  File \"<string>\", line 161, in <module>\nRuntimeError: {message}"),
        }
    }

    /// The first backup folder of the fixture sandbox.
    fn folder(fixture: &Fixture) -> PathBuf {
        backups_root(&fixture.paths).join("dev-3f2a1b4c")
    }

    fn record(fixture: &Fixture) -> Record {
        serde_json::from_slice(&fs::read(folder(fixture).join(RECORD)).unwrap()).unwrap()
    }

    #[test]
    fn dry_run_only_inspects_and_reports_the_backup() {
        let fixture = fixture();
        let fake = Fake::new("Running");
        let plan = plan_with(&fake, &fixture.paths, &fixture.machine, &plenty).unwrap();
        assert_eq!(
            fake.commands(),
            ["--silo-working-account-protocol", "inspect"]
        );
        let directory = backups_root(&fixture.paths).join("dev-3f2a1b4c");
        assert_eq!(plan.backup_directory, directory.display().to_string());
        assert!(!directory.exists(), "a dry run creates nothing");
        assert!(plan.running && !plan.resume && plan.enough_space);
        assert!(plan.backup_bytes > 0);
        assert_eq!(plan.required_bytes, plan.backup_bytes + SPACE_RESERVE);
        assert!(plan.steps[0].starts_with("Stop dev."));
        assert!(plan
            .steps
            .iter()
            .any(|step| step.starts_with("Back up the root and workspace disks")));
        assert!(plan.steps.iter().any(|step| step.contains("/home/silo")));
        assert_eq!(plan.memory_bytes, Some(12 * 1024 * 1024 * 1024));
        assert_eq!(plan.available_memory_bytes, None);
    }

    #[test]
    fn available_memory_is_read_from_meminfo() {
        let meminfo = "MemTotal:       15787692 kB\nMemFree:          611204 kB\nMemAvailable:    7281592 kB\nBuffers:            1024 kB\n";
        assert_eq!(mem_available(meminfo), Some(7_281_592 * 1024));
        assert_eq!(mem_available("MemTotal: 1 kB\n"), None);
        assert_eq!(mem_available("MemAvailable: many kB\n"), None);
    }

    #[test]
    fn a_vm_that_dies_during_the_migration_is_reported_as_stopped_unexpectedly() {
        // Linux kills the VM when the host runs out of memory; the exec then ends early.
        struct Crashing(Fake);
        impl RuntimeRunner for Crashing {
            fn run(
                &self,
                paths: &RuntimePaths,
                args: &[String],
                timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                if args[0] == "exec" && args.iter().any(|arg| arg == "python3") {
                    self.0.calls.borrow_mut().push(args.to_vec());
                    *self.0.status.borrow_mut() = "Crashed".into();
                    return Err(RuntimeError::Failed {
                        operation: "The sandbox operation".into(),
                        exit_code: Some(1),
                        detail: "error: runtime error: exec session ended without exit event"
                            .into(),
                    });
                }
                self.0.run(paths, args, timeout)
            }
        }
        let fixture = fixture();
        let fake = Crashing(Fake::new("Stopped"));
        let failed =
            migrate_with(&fake, &fixture.paths, &fixture.machine, &plenty, &|_| {}).unwrap_err();
        let expected = "The sandbox stopped unexpectedly during the migration. This computer may have run out of memory: stop other sandboxes, then retry.";
        assert_eq!(failed.failure.message, expected);
        assert!(failed
            .failure
            .diagnostic
            .unwrap()
            .contains("exec session ended without exit event"));
        let saved = record(&fixture);
        assert_eq!(saved.phase, Phase::BackedUp);
        assert_eq!(saved.failure.unwrap().message, expected);
        assert!(!fake.0.labels.borrow().contains_key("silo.working-account"));

        // A guest command that fails while the VM keeps running is not a crash.
        let fixture = self::fixture();
        let fake = Fake::new("Stopped");
        fake.fail_on(&["exec"], guest_failure("No space left on device"));
        let failed = migrate(&fake, &fixture, &RefCell::new(Vec::new())).unwrap_err();
        assert_eq!(
            failed.failure.message,
            "Silo could not install the required packages: No space left on device"
        );
    }

    #[test]
    fn the_backup_stays_out_of_the_sandbox_snapshot_history() {
        let _state = crate::test_support::global_state();
        let fixture = fixture();
        let cursor = fixture
            .paths
            .home
            .join("sandboxes/dev/snapshot-lineage.json");
        // No earlier capture: the history stays empty.
        migrate(&Fake::new("Stopped"), &fixture, &RefCell::new(Vec::new())).unwrap();
        assert!(!cursor.exists());

        // An earlier checkpoint stays the parent of the sandbox's next capture.
        let fixture = self::fixture();
        let cursor = fixture
            .paths
            .home
            .join("sandboxes/dev/snapshot-lineage.json");
        let earlier = br#"{"sandbox_id":7,"snapshot_id":"snap_earlier"}"#;
        fs::write(&cursor, earlier).unwrap();
        migrate(&Fake::new("Stopped"), &fixture, &RefCell::new(Vec::new())).unwrap();
        assert_eq!(fs::read(&cursor).unwrap(), earlier);
    }

    #[test]
    fn success_backs_up_first_and_saves_the_label_only_after_a_clean_stop() {
        let fixture = fixture();
        let fake = Fake::new("Running");
        let stages = RefCell::new(Vec::new());
        let directory = migrate(&fake, &fixture, &stages).unwrap();
        assert_eq!(
            fake.commands(),
            [
                "--silo-working-account-protocol",
                "inspect",
                "stop",
                "inspect",
                "snapshot create",
                "start",
                "exec dev",
                "exec dev",
                "stop",
                "inspect",
                "modify",
                "inspect",
            ]
        );
        let guest = fake.guest_commands();
        assert_eq!(guest[0][..2], ["/bin/sh", "-ec"]);
        assert_eq!(guest[1], ["python3", "-c", PAYLOAD, DESKTOP_HELPER]);
        assert_eq!(fake.labels.borrow()["silo.working-account"], "1");
        assert_eq!(*fake.status.borrow(), "Stopped");
        assert_eq!(
            *stages.borrow(),
            [
                Stage::Checking,
                Stage::Stopping,
                Stage::BackingUp,
                Stage::Starting,
                Stage::Installing,
                Stage::Migrating,
                Stage::Finishing,
            ]
        );
        let saved = record(&fixture);
        assert_eq!(saved.phase, Phase::Completed);
        assert_eq!(saved.snapshot.as_deref(), Some("snapshot/dev/snap_0123"));
        assert!(directory
            .join("snapshot/dev/snap_0123/snapshot.json")
            .is_file());
        assert!(directory.join(INSPECTION).is_file());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn guest_failure_keeps_the_backup_stops_and_never_publishes_the_label() {
        let fixture = fixture();
        let fake = Fake::new("Stopped");
        fake.fail_on(
            &[
                "exec",
                "dev",
                "--no-start",
                "--no-tty",
                "--timeout",
                "30m",
                "--user",
                "root",
                "--",
                "python3",
            ],
            guest_failure("UID/GID 1001 belongs to another account."),
        );
        let failed = migrate(&fake, &fixture, &RefCell::new(Vec::new())).unwrap_err();
        assert!(matches!(failed.error, RuntimeError::Failed { .. }));
        assert_eq!(
            failed.failure.message,
            "The account migration inside the sandbox stopped: UID/GID 1001 belongs to another account."
        );
        assert!(!fake.commands().contains(&"modify".to_owned()));
        assert_eq!(
            fake.commands()[fake.commands().len() - 2..],
            ["stop", "inspect"]
        );
        assert!(!fake.labels.borrow().contains_key("silo.working-account"));
        let saved = record(&fixture);
        assert_eq!(saved.phase, Phase::BackedUp);
        let failure = saved.failure.unwrap();
        assert_eq!(
            failure.message,
            "The account migration inside the sandbox stopped: UID/GID 1001 belongs to another account."
        );
        assert!(failure.diagnostic.unwrap().contains("Traceback"));

        let mut view = required(&json!({"labels":{}}));
        annotate(&fixture.paths, &fixture.machine, &mut view);
        let view = view.unwrap();
        assert_eq!(view.status, Status::Failed);
        assert!(view.error.unwrap().contains("UID/GID 1001"));
        assert_eq!(
            view.backup_directory.unwrap(),
            folder(&fixture).display().to_string()
        );
    }

    #[test]
    fn retry_resumes_with_the_same_verified_backup() {
        let fixture = fixture();
        let fake = Fake::new("Stopped");
        fake.fail_on(
            &["start"],
            RuntimeError::Unavailable("The runtime is busy.".into()),
        );
        migrate(&fake, &fixture, &RefCell::new(Vec::new())).unwrap_err();
        assert_eq!(
            record(&fixture).failure.unwrap().message,
            "The runtime is busy."
        );

        let plan = plan_with(&fake, &fixture.paths, &fixture.machine, &scarce).unwrap();
        assert!(plan.resume && plan.enough_space && plan.backup_bytes == 0);
        assert!(plan
            .steps
            .iter()
            .any(|step| step.starts_with("Keep the earlier backup")));

        fake.calls.borrow_mut().clear();
        let directory = migrate(&fake, &fixture, &RefCell::new(Vec::new())).unwrap();
        assert_eq!(
            fake.calls.borrow()[2],
            [
                "snapshot",
                "verify",
                &directory
                    .join("snapshot/dev/snap_0123")
                    .display()
                    .to_string()
            ]
        );
        assert!(!fake.commands().contains(&"snapshot create".to_owned()));
        assert_eq!(fake.guest_commands()[1].last().unwrap(), "--resume");
        assert_eq!(fake.labels.borrow()["silo.working-account"], "1");
        assert_eq!(record(&fixture).phase, Phase::Completed);
    }

    #[test]
    fn insufficient_space_refuses_before_changing_anything() {
        let fixture = fixture();
        let fake = Fake::new("Running");
        let plan = plan_with(&fake, &fixture.paths, &fixture.machine, &scarce).unwrap();
        assert!(!plan.enough_space);
        let error = migrate_with(&fake, &fixture.paths, &fixture.machine, &scarce, &|_| {})
            .unwrap_err()
            .error;
        assert!(
            error
                .to_string()
                .starts_with("Not enough free space for the backup"),
            "{error}"
        );
        assert!(fake
            .commands()
            .iter()
            .all(|command| command == "inspect" || command.starts_with("--")));
        assert!(!backups_root(&fixture.paths).exists());
        assert_eq!(*fake.status.borrow(), "Running");
    }

    #[test]
    fn failed_backup_is_removed_and_retry_starts_it_again() {
        let fixture = fixture();
        let fake = Fake::new("Stopped");
        fake.fail_on(
            &["snapshot", "create"],
            RuntimeError::Failed {
                operation: "The sandbox operation".into(),
                exit_code: Some(1),
                detail: "No space left on device".into(),
            },
        );
        migrate(&fake, &fixture, &RefCell::new(Vec::new())).unwrap_err();
        let directory = folder(&fixture);
        assert!(!directory.join(SNAPSHOT).exists());
        let saved = record(&fixture);
        assert_eq!(saved.phase, Phase::BackingUp);
        assert!(saved
            .failure
            .unwrap()
            .message
            .starts_with("Silo could not back up the disks: Not enough free disk space."));
        assert!(!fake.commands().contains(&"start".to_owned()));

        let mut view = required(&json!({}));
        annotate(&fixture.paths, &fixture.machine, &mut view);
        assert_eq!(view.as_ref().unwrap().status, Status::Failed);
        assert_eq!(
            view.unwrap().backup_directory,
            None,
            "an incomplete backup is not offered"
        );

        assert!(
            !plan_with(&fake, &fixture.paths, &fixture.machine, &plenty)
                .unwrap()
                .resume
        );
        migrate(&fake, &fixture, &RefCell::new(Vec::new())).unwrap();
        assert_eq!(
            fake.guest_commands().last().unwrap().last().unwrap(),
            DESKTOP_HELPER
        );
    }

    #[test]
    fn cancelled_backup_discards_everything_and_leaves_the_sandbox_stopped() {
        let fixture = fixture();
        let fake = Fake::new("Running");
        fake.fail_on(
            &["snapshot", "create"],
            RuntimeError::Cancelled {
                operation: "The sandbox operation".into(),
            },
        );
        let error = migrate(&fake, &fixture, &RefCell::new(Vec::new()))
            .unwrap_err()
            .error;
        assert!(matches!(error, RuntimeError::Cancelled { .. }));
        assert!(!folder(&fixture).exists());
        assert_eq!(*fake.status.borrow(), "Stopped");
        let mut view = required(&json!({}));
        annotate(&fixture.paths, &fixture.machine, &mut view);
        assert_eq!(view.unwrap().status, Status::Required);
    }

    #[test]
    fn only_standard_old_sandboxes_are_migrated() {
        let fixture = fixture();
        for (label, expected) in [
            (json!("1"), "already uses the silo account"),
            (json!("2"), "cannot migrate"),
        ] {
            let fake = Fake::new("Stopped");
            fake.labels
                .borrow_mut()
                .insert("silo.working-account".into(), label);
            let error = plan_with(&fake, &fixture.paths, &fixture.machine, &plenty).unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        }
        let fake = Fake::new("Stopped");
        *fake.mounts.borrow_mut() =
            json!([{"type":"DiskImage","guest":"/workspace","host":"/disk.raw"}]);
        assert!(plan_with(&fake, &fixture.paths, &fixture.machine, &plenty)
            .unwrap_err()
            .to_string()
            .contains("standard Silo workspace disk"));
        let fake = Fake::new("Stopped");
        fake.labels
            .borrow_mut()
            .insert("silo.machine-id".into(), json!("another"));
        assert!(plan_with(&fake, &fixture.paths, &fixture.machine, &plenty)
            .unwrap_err()
            .to_string()
            .contains("identity changed"));
        let fake = Fake::new("Paused");
        assert!(plan_with(&fake, &fixture.paths, &fixture.machine, &plenty)
            .unwrap_err()
            .to_string()
            .contains("dev is paused"));
        let fake = Fake::new("Crashed");
        assert!(
            !plan_with(&fake, &fixture.paths, &fixture.machine, &plenty)
                .unwrap()
                .running
        );
    }

    #[test]
    fn folders_that_are_not_this_migration_are_kept_and_skipped() {
        let _state = crate::test_support::global_state();
        let fixture = fixture();
        // Someone else's files, and another sandbox's unfinished migration.
        let taken = folder(&fixture);
        fs::create_dir_all(&taken).unwrap();
        fs::write(taken.join("notes.txt"), "mine").unwrap();
        let foreign = backups_root(&fixture.paths).join("dev-3f2a1b4c-2");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join(RECORD), json!({"version":1,"machineId":"other","sandbox":"dev","phase":"backed-up","updatedAt":0}).to_string()).unwrap();
        let fake = Fake::new("Stopped");
        let plan = plan_with(&fake, &fixture.paths, &fixture.machine, &plenty).unwrap();
        let third = backups_root(&fixture.paths).join("dev-3f2a1b4c-3");
        assert_eq!(plan.backup_directory, third.display().to_string());
        assert!(!plan.resume);
        assert_eq!(
            migrate(&fake, &fixture, &RefCell::new(Vec::new())).unwrap(),
            third
        );
        assert_eq!(fs::read_to_string(taken.join("notes.txt")).unwrap(), "mine");
        assert!(fs::read_to_string(foreign.join(RECORD))
            .unwrap()
            .contains("other"));

        // A finished backup is kept: migrating the same sandbox again uses a new folder.
        fake.labels.borrow_mut().remove("silo.working-account");
        let plan = plan_with(&fake, &fixture.paths, &fixture.machine, &plenty).unwrap();
        assert_eq!(
            plan.backup_directory,
            backups_root(&fixture.paths)
                .join("dev-3f2a1b4c-4")
                .display()
                .to_string()
        );

        // An unreadable progress file may be this sandbox's: it stops the migration.
        fs::write(third.join(RECORD), "{").unwrap();
        let error = plan_with(&fake, &fixture.paths, &fixture.machine, &plenty).unwrap_err();
        assert!(error.to_string().contains("unreadable"), "{error}");
    }

    #[test]
    fn failure_messages_never_embed_paths() {
        for error in [not_enough_space(3, 1), invalid("x")] {
            let summary = failure_report(&error).summary;
            assert!(!summary.contains("[redacted]"), "{summary}");
        }
        let _state = crate::test_support::global_state();
        let fixture = fixture();
        let fake = Fake::new("Stopped");
        let failed =
            migrate_with(&fake, &fixture.paths, &fixture.machine, &scarce, &|_| {}).unwrap_err();
        assert!(
            !failed.failure.message.contains("[redacted]"),
            "{}",
            failed.failure.message
        );
    }

    #[test]
    fn guest_reason_reads_the_last_exception_line() {
        assert_eq!(
            guest_reason("Traceback\nRuntimeError: Account verification failed.\n").unwrap(),
            "Account verification failed."
        );
        assert_eq!(
            guest_reason("subprocess.CalledProcessError: Command '('apt-get', 'update')' returned non-zero exit status 100.").unwrap(),
            "Command '('apt-get', 'update')' returned non-zero exit status 100."
        );
        assert_eq!(guest_reason("E: Unable to locate package sudo"), None);
        assert_eq!(guest_reason(""), None);
    }

    #[test]
    fn only_backup_and_checks_can_be_cancelled() {
        let cancellable: Vec<_> = [
            Stage::Checking,
            Stage::Stopping,
            Stage::BackingUp,
            Stage::Starting,
            Stage::Installing,
            Stage::Migrating,
            Stage::Finishing,
        ]
        .into_iter()
        .filter(|stage| stage.cancellable())
        .collect();
        assert_eq!(cancellable, [Stage::Checking, Stage::BackingUp]);
    }

    #[test]
    fn the_queue_shows_each_step_and_the_outcome_names_the_backup() {
        let _state = crate::test_support::global_state();
        let fixture = fixture();
        let fake = Fake::new("Stopped");
        let seen = RefCell::new(Vec::new());
        let observe = || {
            let queue = OPERATIONS.snapshot();
            let Some(entry) = queue
                .running
                .iter()
                .find(|entry| entry.vm_id.as_deref() == Some(ID))
            else {
                return;
            };
            let mut view = required(&json!({}));
            annotate(&fixture.paths, &fixture.machine, &mut view);
            let view = view.unwrap();
            assert_eq!(view.status, Status::Running);
            assert_eq!(entry.kind, operation_gate::OperationKind::AccountMigration);
            seen.borrow_mut()
                .push((entry.label.clone(), entry.cancellable, view.stage));
        };
        let outcome = run_local(&fake, &fixture.paths, ID, &observe).unwrap();
        assert!(outcome.succeeded);
        let directory = folder(&fixture).display().to_string();
        assert_eq!(
            outcome.backup_directory.as_deref(),
            Some(directory.as_str())
        );
        let seen = seen.into_inner();
        assert_eq!(
            seen[0],
            (
                "Migrating dev to the silo account".into(),
                true,
                Some("Checking the sandbox".into())
            )
        );
        assert!(seen.contains(&(
            "Migrating dev to the silo account: Backing up the disks".into(),
            true,
            Some("Backing up the disks".into())
        )));
        assert!(seen.contains(&(
            "Migrating dev to the silo account: Moving files to the silo account".into(),
            false,
            Some("Moving files to the silo account".into())
        )));
        assert!(OPERATIONS.is_vm_idle(ID));
        let mut view = required(&json!({}));
        annotate(&fixture.paths, &fixture.machine, &mut view);
        assert_eq!(
            view.unwrap().status,
            Status::Required,
            "no running marker is left behind"
        );

        let fixture = self::fixture();
        let fake = Fake::new("Stopped");
        fake.fail_on(&["start"], guest_failure("unused"));
        let outcome = run_local(&fake, &fixture.paths, ID, &|| {}).unwrap();
        assert!(!outcome.succeeded);
        assert_eq!(
            outcome.backup_directory,
            Some(folder(&fixture).display().to_string())
        );
        assert!(outcome
            .error
            .unwrap()
            .starts_with("Silo could not start the sandbox: "));
        assert!(outcome.diagnostic.unwrap().contains("Exit code 1"));
    }
}
