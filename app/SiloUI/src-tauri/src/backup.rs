use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAGIC: &[u8; 16] = b"SILO-BACKUP\0\0\0\0\0";
const FORMAT_VERSION: u32 = 3;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_COMMAND_OUTPUT: usize = 32 * 1024;
const MAX_SNAPSHOT_INDEX_OUTPUT: usize = 1024 * 1024;
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DEFAULT_MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    /// The shared cancel flag, so the operation gate and this controller can point at the
    /// same bit and agree on cancellation regardless of which path the user takes.
    pub(crate) fn flag(&self) -> Arc<AtomicBool> {
        self.0.clone()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MsbCommand {
    pub(crate) metadata: PathBuf,
    pub(crate) executable: PathBuf,
    pub(crate) home: PathBuf,
    pub(crate) storage_home: Option<PathBuf>,
    pub(crate) library: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct CommandOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) trait MsbRunner: Send + Sync {
    fn run(
        &self,
        command: &MsbCommand,
        arguments: &[String],
        timeout: Duration,
        cancellation: &Cancellation,
    ) -> Result<CommandOutput, BackupError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SystemMsbRunner;

impl MsbRunner for SystemMsbRunner {
    fn run(
        &self,
        command: &MsbCommand,
        arguments: &[String],
        timeout: Duration,
        cancellation: &Cancellation,
    ) -> Result<CommandOutput, BackupError> {
        if cancellation.cancelled() {
            return Err(BackupError::Cancelled);
        }
        crate::runtime::prepare_runtime_home(&command.home, command.storage_home.as_deref())
            .map_err(|error| BackupError::InvalidRequest(error.to_string()))?;
        // Export and import only run `snapshot` commands that write native
        // snapshot data. Such a command can outlive Silo; keep the lock in the
        // child until it exits, even if Silo dies.
        let worker_lock = if arguments.first().is_some_and(|arg| arg == "snapshot") {
            Some(wait_for_interrupted_command(&command.home, timeout).map_err(BackupError::Io)?)
        } else {
            None
        };
        let mut process = Command::new(&command.executable);
        if let Some(lock) = &worker_lock {
            inherit_worker_lock(&mut process, lock);
        }
        let mut child = process
            .args(arguments)
            .env("MSB_HOME", &command.home)
            .env("MSB_PATH", &command.executable)
            .env("MSB_LIBKRUNFW_PATH", &command.library)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(BackupError::Io)?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let snapshot_index = arguments.iter().map(String::as_str).eq(["snapshot", "list", "--format", "json"]);
        let stdout_reader = thread::spawn(move || {
            read_output(stdout, if snapshot_index { MAX_SNAPSHOT_INDEX_OUTPUT } else { MAX_COMMAND_OUTPUT }, !snapshot_index)
        });
        let stderr_reader = thread::spawn(move || read_output(stderr, MAX_COMMAND_OUTPUT, true));
        let started = Instant::now();
        loop {
            if cancellation.cancelled() {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(BackupError::Cancelled);
            }
            if started.elapsed() >= timeout {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(BackupError::CommandTimeout);
            }
            if let Some(status) = child.try_wait().map_err(BackupError::Io)? {
                let (stdout, stdout_truncated) = stdout_reader
                    .join()
                    .map_err(|_| BackupError::Io(io::Error::other("stdout reader failed")))??;
                let (stderr, _) = stderr_reader
                    .join()
                    .map_err(|_| BackupError::Io(io::Error::other("stderr reader failed")))??;
                if snapshot_index && stdout_truncated {
                    return Err(BackupError::InvalidRequest(
                        "The runtime checkpoint index exceeds Silo's size safety limit.".into(),
                    ));
                }
                return Ok(CommandOutput {
                    status,
                    stdout: if snapshot_index { String::from_utf8_lossy(&stdout).trim().to_owned() } else { bounded_output(&stdout) },
                    stderr: bounded_output(&stderr),
                });
            }
            thread::sleep(COMMAND_POLL_INTERVAL);
        }
    }
}

fn inherit_worker_lock(command: &mut Command, lock: &File) {
    use std::os::unix::process::CommandExt;
    let fd = lock.as_raw_fd();
    // SAFETY: pre_exec only calls async-signal-safe fcntl on this owned FD.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Also held by a surviving snapshot/create child after the app exits. A bounded
/// wait prevents recovery from racing that child's writes or hanging forever.
pub(crate) fn wait_for_interrupted_command(home: &Path, timeout: Duration) -> io::Result<File> {
    fs::create_dir_all(home)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join(".silo-backup-worker.lock"))?;
    let started = Instant::now();
    loop {
        // SAFETY: file owns this valid descriptor for the duration of the lock.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(file);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::WouldBlock {
            return Err(error);
        }
        if started.elapsed() >= timeout {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "The previous export or import command is still finishing. Wait a moment and relaunch Silo to resume.",
            ));
        }
        thread::sleep(COMMAND_POLL_INTERVAL);
    }
}

fn read_output(mut input: impl Read, limit: usize, keep_tail: bool) -> io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let count = input.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        if keep_tail {
            output.extend_from_slice(&chunk[..count]);
            if output.len() > limit {
                output.drain(..output.len() - limit);
                truncated = true;
            }
        } else {
            let remaining = limit.saturating_sub(output.len());
            output.extend_from_slice(&chunk[..count.min(remaining)]);
            truncated |= count > remaining;
        }
    }
    Ok((output, truncated))
}

fn bounded_output(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(MAX_COMMAND_OUTPUT);
    String::from_utf8_lossy(&bytes[start..]).trim().to_owned()
}

#[derive(Debug)]
pub(crate) enum BackupError {
    Busy,
    Cancelled,
    CommandTimeout,
    CommandFailed { operation: String, detail: String },
    /// A sandbox name is already taken.
    Conflict(String),
    /// A file already exists at the given path.
    FileConflict(String),
    /// A stored import group with the same identity already exists.
    ImportGroupConflict(String),
    InvalidArchive(String),
    UnsupportedStorage(String),
    InvalidRequest(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => write!(formatter, "Another export or import is running."),
            Self::Cancelled => write!(formatter, "The operation was cancelled."),
            Self::CommandTimeout => write!(formatter, "The bundled runtime operation timed out."),
            Self::CommandFailed { operation, detail } => {
                write!(formatter, "{operation} failed: {detail}")
            }
            Self::Conflict(name) => write!(formatter, "A VM named {name} already exists."),
            Self::FileConflict(path) => write!(formatter, "A file already exists at {path}."),
            Self::ImportGroupConflict(group) => write!(
                formatter,
                "An earlier import is still stored as {group}. Try the import again."
            ),
            Self::InvalidArchive(detail) => write!(formatter, "Invalid Silo export: {detail}"),
            Self::UnsupportedStorage(detail) => write!(formatter, "{detail}"),
            Self::InvalidRequest(detail) => write!(formatter, "{detail}"),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for BackupError {}

impl From<io::Error> for BackupError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for BackupError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct BackupSource {
    pub(crate) name: String,
    pub(crate) snapshot_group: String,
    pub(crate) was_running: bool,
    pub(crate) runtime_config: Value,
    pub(crate) machine_config: Value,
    /// When set, export an already-captured checkpoint member from
    /// `snapshot_group` instead of capturing the sandbox's current state.
    /// `was_running` is irrelevant on this path (no new capture is taken).
    pub(crate) existing_member: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct BackupRequest {
    pub(crate) destination: PathBuf,
    pub(crate) sources: Vec<BackupSource>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BackupResult {
    pub(crate) created_at_ms: u64,
    pub(crate) destination: PathBuf,
    pub(crate) size_bytes: u64,
    pub(crate) sandboxes: Vec<String>,
    /// The archive is valid even when one of these post-capture restarts failed.
    pub(crate) restart_failures: Vec<RestartFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestartFailure {
    pub(crate) sandbox: String,
    pub(crate) detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArchiveInspection {
    pub(crate) created_at_ms: u64,
    pub(crate) size_bytes: u64,
    pub(crate) sandboxes: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct RestoreRequest {
    pub(crate) archive: PathBuf,
    pub(crate) source_name: Option<String>,
    pub(crate) new_name: String,
}

/// A verified, extracted snapshot. The private staging directory is deleted on drop.
pub(crate) struct PreparedRestore {
    pub(crate) source_name: String,
    pub(crate) new_name: String,
    pub(crate) runtime_config: Value,
    pub(crate) machine_config: Value,
    pub(crate) snapshot_group: String,
    pub(crate) snapshot_member: String,
    _stage: tempfile::TempDir,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageManifest {
    schema_version: u32,
    created_at_ms: u64,
    runtime: RuntimeManifest,
    sandboxes: Vec<PackageSandbox>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeManifest {
    name: String,
    version: String,
    snapshot_format: String,
    guest_architecture: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageSandbox {
    name: String,
    runtime_config: Value,
    machine_config: Value,
    payload_size: u64,
    payload_sha256: String,
    /// Format 3 reserves this list for separate disk payloads. The workspace
    /// disk travels inside the MicroSandbox snapshot, so it must stay empty.
    volumes: Vec<Value>,
}

struct OperationGuard<'a>(&'a AtomicBool);

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) struct BackupService<R = SystemMsbRunner> {
    command: MsbCommand,
    scratch_root: PathBuf,
    runner: R,
    busy: AtomicBool,
    command_timeout: Duration,
    max_archive_bytes: u64,
}

impl BackupService<SystemMsbRunner> {
    pub(crate) fn new(command: MsbCommand, scratch_root: PathBuf) -> Self {
        Self::with_runner(command, scratch_root, SystemMsbRunner)
    }
}

impl<R: MsbRunner> BackupService<R> {
    pub(crate) fn with_runner(command: MsbCommand, scratch_root: PathBuf, runner: R) -> Self {
        Self {
            command,
            scratch_root,
            runner,
            busy: AtomicBool::new(false),
            command_timeout: DEFAULT_COMMAND_TIMEOUT,
            max_archive_bytes: DEFAULT_MAX_ARCHIVE_BYTES,
        }
    }

    fn begin(&self) -> Result<OperationGuard<'_>, BackupError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| BackupError::Busy)?;
        Ok(OperationGuard(&self.busy))
    }

    pub(crate) fn cleanup_interrupted_staging(&self) -> io::Result<()> {
        let entries = match fs::read_dir(&self.scratch_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name.starts_with("backup-") || name.starts_with("restore-"))
                && entry.file_type()?.is_dir()
            {
                fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn create_backup(
        &self,
        request: BackupRequest,
        cancellation: &Cancellation,
    ) -> Result<BackupResult, BackupError> {
        self.create_backup_with_token(request, cancellation, None)
    }

    pub(crate) fn create_backup_with_token(
        &self,
        request: BackupRequest,
        cancellation: &Cancellation,
        token: Option<&str>,
    ) -> Result<BackupResult, BackupError> {
        if let Some(token) = token {
            uuid::Uuid::parse_str(token).map_err(|_| {
                BackupError::InvalidRequest("Invalid backup operation identity.".into())
            })?;
        }
        let _guard = self.begin()?;
        validate_backup_request(&request)?;
        fs::create_dir_all(&self.scratch_root)?;
        let stage = tempfile::Builder::new()
            .prefix("backup-")
            .tempdir_in(&self.scratch_root)?;
        let mut payloads = Vec::with_capacity(request.sources.len());
        let mut total_payload_bytes = 0_u64;
        let restart_failures = Vec::new();

        for (index, source) in request.sources.iter().enumerate() {
            check_cancelled(cancellation)?;
            validate_sandbox_name(&source.name)?;
            validate_snapshottable_config(&source.name, &source.runtime_config)?;
            validate_machine_config(&source.name, &source.machine_config)?;
            validate_volume_sources(&source.name, &source.runtime_config, &source.machine_config)?;
            let snapshot_group = source.snapshot_group.clone();
            let flush = if source.was_running {
                "required"
            } else {
                "auto"
            };
            let capture_result = (|| {
                // A checkpoint export reuses an already-captured, immutable member;
                // a state export captures the sandbox's current disk first.
                let snapshot = if let Some(member) = &source.existing_member {
                    self.captured_snapshot_path(&snapshot_group, member, cancellation)?
                } else {
                    let snapshot_name = format!("silo-backup-{index}-{}", unique_suffix());
                    self.require_success(
                        "Capturing VM disk",
                        &[
                            "snapshot".into(),
                            "create".into(),
                            snapshot_name.clone(),
                            "--from-sandbox".into(),
                            source.name.clone(),
                            "--group".into(),
                            snapshot_group.clone(),
                            "--guest-flush".into(),
                            flush.into(),
                            "--integrity".into(),
                            "--quiet".into(),
                        ],
                        cancellation,
                    )?;
                    // Capture advances MicroSandbox's source lineage. Its ancestor must
                    // remain in the native snapshot store even if archive writing fails.
                    self.captured_snapshot_path(&snapshot_group, &snapshot_name, cancellation)?
                };
                self.require_success(
                    "Verifying captured VM disk",
                    &[
                        "snapshot".into(),
                        "verify".into(),
                        snapshot.to_string_lossy().into_owned(),
                    ],
                    cancellation,
                )?;
                let payload_path = stage.path().join(format!("{index}.msb"));
                self.require_success(
                    "Writing self-contained VM snapshot",
                    &[
                        "snapshot".into(),
                        "save".into(),
                        snapshot.to_string_lossy().into_owned(),
                        payload_path.to_string_lossy().into_owned(),
                        "--with-parents".into(),
                        "--with-image".into(),
                    ],
                    cancellation,
                )?;
                Ok::<_, BackupError>(payload_path)
            })();
            let payload_path = capture_result?;
            let (payload_size, payload_sha256) =
                hash_regular_file(&payload_path, self.max_archive_bytes, cancellation)?;
            total_payload_bytes = total_payload_bytes
                .checked_add(payload_size)
                .filter(|size| *size <= self.max_archive_bytes)
                .ok_or_else(|| {
                    BackupError::InvalidRequest(
                        "The selected VM snapshots exceed the export size safety limit.".into(),
                    )
                })?;
            payloads.push((source, payload_path, payload_size, payload_sha256));
        }

        let manifest = PackageManifest {
            schema_version: FORMAT_VERSION,
            created_at_ms: now_ms(),
            runtime: RuntimeManifest {
                name: "microsandbox".into(),
                version: "0.7.2".into(),
                snapshot_format: "msb-snapshot-tar-zstd-v0.7".into(),
                guest_architecture: std::env::consts::ARCH.into(),
            },
            sandboxes: payloads
                .iter()
                .map(|(source, _, payload_size, payload_sha256)| PackageSandbox {
                    name: source.name.clone(),
                    runtime_config: source.runtime_config.clone(),
                    machine_config: source.machine_config.clone(),
                    payload_size: *payload_size,
                    payload_sha256: payload_sha256.clone(),
                    // Format 3 keeps this field; MicroSandbox's snapshot carries the disks.
                    volumes: Vec::new(),
                })
                .collect(),
        };
        let archive_payloads = payloads
            .iter()
            .map(|(_, snapshot, _, _)| snapshot.as_path())
            .collect::<Vec<_>>();
        let size_bytes = write_immutable_package(
            &request.destination,
            &manifest,
            &archive_payloads,
            cancellation,
            token,
        )?;
        Ok(BackupResult {
            created_at_ms: manifest.created_at_ms,
            destination: request.destination,
            size_bytes,
            sandboxes: request
                .sources
                .into_iter()
                .map(|source| source.name)
                .collect(),
            restart_failures,
        })
    }

    fn captured_snapshot_path(
        &self,
        group: &str,
        name: &str,
        cancellation: &Cancellation,
    ) -> Result<PathBuf, BackupError> {
        let output = self.require_success(
            "Locating captured VM disk",
            &["snapshot".into(), "list".into(), "--format".into(), "json".into()],
            cancellation,
        )?;
        let entries: Vec<Value> = serde_json::from_str(&output.stdout).map_err(|_| {
            BackupError::InvalidRequest("The runtime returned an invalid snapshot index.".into())
        })?;
        let mut matches = entries.iter().filter(|entry| {
            entry["group"] == group && entry["name"] == name && entry["availability"] == "ready"
        });
        let entry = matches.next().filter(|_| matches.next().is_none()).ok_or_else(|| {
            BackupError::InvalidRequest(
                "The runtime did not publish exactly one ready captured snapshot.".into(),
            )
        })?;
        let id = entry["snapshot_id"].as_str().filter(|id| {
            id.len() == 37
                && id.starts_with("snap_")
                && id[5..].bytes().all(|byte| byte.is_ascii_hexdigit())
        }).ok_or_else(|| BackupError::InvalidRequest("The runtime returned an invalid snapshot identity.".into()))?;
        let path = Path::new(entry["artifact_path"].as_str().ok_or_else(|| {
            BackupError::InvalidRequest("The runtime omitted the captured snapshot path.".into())
        })?);
        let native_store = self.command.storage_home.as_deref().unwrap_or(&self.command.home).join("snapshots");
        let native_store = fs::canonicalize(native_store)?;
        let path = fs::canonicalize(path)?;
        if !path.is_dir()
            || path.file_name().is_none_or(|part| part != id)
            || path.parent().and_then(Path::file_name).is_none_or(|part| part != group)
            || path.parent().and_then(Path::parent) != Some(native_store.as_path())
        {
            return Err(BackupError::InvalidRequest(
                "The captured snapshot is outside the native snapshot store.".into(),
            ));
        }
        Ok(path)
    }

    pub(crate) fn inspect_archive(
        &self,
        archive: &Path,
        cancellation: &Cancellation,
    ) -> Result<ArchiveInspection, BackupError> {
        let package = read_and_verify_package(archive, self.max_archive_bytes, cancellation, None)?;
        Ok(ArchiveInspection {
            created_at_ms: package.manifest.created_at_ms,
            size_bytes: package.size_bytes,
            sandboxes: package
                .manifest
                .sandboxes
                .iter()
                .map(|sandbox| sandbox.name.clone())
                .collect(),
        })
    }

    pub(crate) fn prepare_restore(
        &self,
        request: RestoreRequest,
        cancellation: &Cancellation,
    ) -> Result<PreparedRestore, BackupError> {
        let _guard = self.begin()?;
        validate_sandbox_name(&request.new_name)?;
        let names = self.list_sandbox_names(cancellation)?;
        if names.contains(&request.new_name) {
            return Err(BackupError::Conflict(request.new_name));
        }
        fs::create_dir_all(&self.scratch_root)?;
        let stage = tempfile::Builder::new()
            .prefix("restore-")
            .tempdir_in(&self.scratch_root)?;
        let package = read_and_verify_package(
            &request.archive,
            self.max_archive_bytes,
            cancellation,
            Some(stage.path()),
        )?;
        let selected_index =
            select_restore_source(&package.manifest, request.source_name.as_deref())?;
        let source = &package.manifest.sandboxes[selected_index];
        let payload_path = package.snapshot_payload_paths[selected_index]
            .as_ref()
            .ok_or_else(|| {
                BackupError::InvalidArchive("snapshot payload was not extracted".into())
            })?;
        let import_group = format!("silo-import-{}", uuid::Uuid::new_v4().simple());
        let before = self.require_success(
            "Checking imported checkpoint identity",
            &[
                "snapshot".into(),
                "list".into(),
                "--format".into(),
                "json".into(),
            ],
            cancellation,
        )?;
        let before: Vec<Value> = serde_json::from_str(&before.stdout).map_err(|_| {
            BackupError::InvalidArchive("the runtime returned an invalid checkpoint index".into())
        })?;
        if before.iter().any(|entry| entry["group"] == import_group) {
            return Err(BackupError::ImportGroupConflict(import_group));
        }
        let import_stages_before = cache_import_stages(&self.command.home)?;
        let load_result = self.require_success(
            "Loading VM snapshot",
            &[
                "snapshot".into(),
                "load".into(),
                payload_path.to_string_lossy().into_owned(),
                "--group".into(),
                import_group.clone(),
            ],
            cancellation,
        );
        let _output = match load_result {
            Ok(output) => output,
            Err(error) => {
                cleanup_new_cache_import_stages(&self.command.home, &import_stages_before);
                return Err(error);
            }
        };
        // The CLI's printed reference is useful for diagnostics only. Resolve
        // the loaded member from the runtime's indexed JSON before using it.
        let indexed = match self.require_success(
            "Checking imported checkpoint",
            &[
                "snapshot".into(),
                "list".into(),
                "--format".into(),
                "json".into(),
            ],
            cancellation,
        ) {
            Ok(indexed) => indexed,
            Err(error) => {
                eprintln!("Retained imported snapshot group {import_group} for native recovery after index failure.");
                return Err(error);
            }
        };
        let entries: Vec<Value> = match serde_json::from_str(&indexed.stdout) {
            Ok(entries) => entries,
            Err(_) => {
                eprintln!("Retained imported snapshot group {import_group} for native recovery after invalid index data.");
                return Err(BackupError::InvalidArchive(
                    "the runtime returned an invalid checkpoint index".into(),
                ));
            }
        };
        let imported: Vec<_> = entries
            .iter()
            .filter(|entry| entry["group"] == import_group)
            .collect();
        if imported.is_empty() || imported.iter().any(|entry| entry["availability"] != "ready") {
            cleanup_new_cache_import_stages(&self.command.home, &import_stages_before);
            eprintln!("Retained imported snapshot group {import_group} for native recovery after incomplete import.");
            return Err(BackupError::InvalidArchive(
                "the runtime did not publish a complete ready imported checkpoint group".into(),
            ));
        }
        let head = self.require_success(
            "Checking imported checkpoint head",
            &["snapshot".into(), "head".into(), import_group.clone(), "--format".into(), "json".into()],
            cancellation,
        )?;
        let head: Value = serde_json::from_str(&head.stdout).map_err(|_| {
            BackupError::InvalidArchive("the runtime returned an invalid imported checkpoint head".into())
        })?;
        if head["group"] != import_group {
            return Err(BackupError::InvalidArchive("the imported checkpoint head belongs to another group".into()));
        }
        let head_id = head["head"].as_str().filter(|id| {
            id.len() == 37 && id.starts_with("snap_") && id[5..].bytes().all(|byte| byte.is_ascii_hexdigit())
        }).ok_or_else(|| BackupError::InvalidArchive("the imported checkpoint head is missing or invalid".into()))?;
        let mut matches = imported.iter().filter(|entry| entry["snapshot_id"] == head_id);
        let head_member = matches.next().filter(|_| matches.next().is_none()).ok_or_else(|| {
            BackupError::InvalidArchive("the imported checkpoint head is not uniquely indexed".into())
        })?;
        let snapshot_member = head_member["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                BackupError::InvalidArchive(
                    "the runtime omitted the imported checkpoint member".into(),
                )
            })?
            .to_owned();
        if let Err(error) = self.require_success(
            "Verifying restored VM disk",
            &[
                "snapshot".into(),
                "verify".into(),
                format!("{import_group}:{snapshot_member}"),
            ],
            cancellation,
        ) {
            eprintln!("Retained imported snapshot group {import_group} for native recovery after verification failure.");
            cleanup_new_cache_import_stages(&self.command.home, &import_stages_before);
            return Err(error);
        }
        Ok(PreparedRestore {
            source_name: source.name.clone(),
            new_name: request.new_name,
            runtime_config: source.runtime_config.clone(),
            machine_config: source.machine_config.clone(),
            snapshot_group: import_group,
            snapshot_member,
            _stage: stage,
        })
    }

    fn list_sandbox_names(
        &self,
        cancellation: &Cancellation,
    ) -> Result<HashSet<String>, BackupError> {
        let output = self.require_success(
            "Checking VM name",
            &["list".into(), "--format".into(), "json".into()],
            cancellation,
        )?;
        let value: Value =
            serde_json::from_str(&output.stdout).map_err(|_| BackupError::CommandFailed {
                operation: "Checking VM name".into(),
                detail: "the bundled runtime returned malformed VM data".into(),
            })?;
        let rows = value.as_array().ok_or_else(|| BackupError::CommandFailed {
            operation: "Checking VM name".into(),
            detail: "the bundled runtime returned an unexpected VM list".into(),
        })?;
        rows.iter()
            .map(|row| {
                row.get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| BackupError::CommandFailed {
                        operation: "Checking VM name".into(),
                        detail: "the bundled runtime omitted a VM name".into(),
                    })
            })
            .collect()
    }

    fn require_success(
        &self,
        operation: &str,
        arguments: &[String],
        cancellation: &Cancellation,
    ) -> Result<CommandOutput, BackupError> {
        let output =
            self.runner
                .run(&self.command, arguments, self.command_timeout, cancellation)?;
        if output.status.success() {
            return Ok(output);
        }
        let detail = if output.stderr.is_empty() {
            if output.stdout.is_empty() {
                "the bundled runtime returned no error detail".into()
            } else {
                output.stdout.clone()
            }
        } else {
            output.stderr.clone()
        };
        Err(BackupError::CommandFailed {
            operation: operation.into(),
            detail,
        })
    }
}

fn cache_import_stages(home: &Path) -> Result<HashSet<std::ffi::OsString>, BackupError> {
    let root = home.join("cache/tmp");
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => return Err(BackupError::Io(error)),
    };
    Ok(entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .filter(|name| name.to_string_lossy().starts_with("snapshot-import-"))
        .collect())
}

fn cleanup_new_cache_import_stages(home: &Path, before: &HashSet<std::ffi::OsString>) {
    let root = home.join("cache/tmp");
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        if before.contains(&name) || !name.to_string_lossy().starts_with("snapshot-import-") {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || metadata.is_file() {
            let _ = fs::remove_file(path);
        } else if metadata.is_dir() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

struct VerifiedPackage {
    manifest: PackageManifest,
    snapshot_payload_paths: Vec<Option<PathBuf>>,
    size_bytes: u64,
}

fn read_and_verify_package(
    path: &Path,
    max_archive_bytes: u64,
    cancellation: &Cancellation,
    extract_dir: Option<&Path>,
) -> Result<VerifiedPackage, BackupError> {
    check_cancelled(cancellation)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BackupError::InvalidArchive(
            "the selected item is not a regular file".into(),
        ));
    }
    if metadata.len() > max_archive_bytes {
        return Err(BackupError::InvalidArchive(format!(
            "the archive exceeds the {} byte safety limit",
            max_archive_bytes
        )));
    }
    let mut file = File::open(path)?;
    let mut magic = [0_u8; MAGIC.len()];
    file.read_exact(&mut magic)
        .map_err(|_| BackupError::InvalidArchive("the file header is incomplete".into()))?;
    if &magic != MAGIC {
        return Err(BackupError::InvalidArchive(
            "the file header is not recognized".into(),
        ));
    }
    let version = read_u32(&mut file)?;
    if version != FORMAT_VERSION {
        return Err(BackupError::InvalidArchive(format!(
            "format version {version} is not supported"
        )));
    }
    let manifest_len = read_u64(&mut file)?;
    if manifest_len == 0 || manifest_len > MAX_MANIFEST_BYTES {
        return Err(BackupError::InvalidArchive(
            "the manifest size is invalid".into(),
        ));
    }
    let mut manifest_bytes = vec![0; manifest_len as usize];
    file.read_exact(&mut manifest_bytes)
        .map_err(|_| BackupError::InvalidArchive("the manifest is incomplete".into()))?;
    let manifest: PackageManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| BackupError::InvalidArchive("the manifest is malformed".into()))?;
    validate_manifest(&manifest)?;

    let header_len = MAGIC.len() as u64 + 4 + 8 + manifest_len;
    // `validate_manifest` rejects separate volume payloads, so the snapshot
    // payloads are the whole body.
    let payload_total = manifest
        .sandboxes
        .iter()
        .try_fold(0_u64, |sum, sandbox| sum.checked_add(sandbox.payload_size))
        .ok_or_else(|| BackupError::InvalidArchive("payload sizes overflow".into()))?;
    let expected_len = header_len
        .checked_add(payload_total)
        .ok_or_else(|| BackupError::InvalidArchive("archive size overflows".into()))?;
    if expected_len != metadata.len() {
        return Err(BackupError::InvalidArchive(
            "the archive length does not match its manifest".into(),
        ));
    }

    let mut snapshot_payload_paths = Vec::with_capacity(manifest.sandboxes.len());
    for (index, sandbox) in manifest.sandboxes.iter().enumerate() {
        let snapshot_output = extract_verified_payload(
            &mut file,
            sandbox.payload_size,
            &sandbox.payload_sha256,
            extract_dir.map(|dir| dir.join(format!("snapshot-{index}.tar.zst"))),
            &format!("snapshot payload for {}", sandbox.name),
            cancellation,
        )?;
        snapshot_payload_paths.push(snapshot_output);
    }
    Ok(VerifiedPackage {
        manifest,
        snapshot_payload_paths,
        size_bytes: metadata.len(),
    })
}

fn validate_manifest(manifest: &PackageManifest) -> Result<(), BackupError> {
    let architecture = manifest.runtime.guest_architecture.as_str();
    if !matches!(architecture, "aarch64" | "x86_64") || architecture != std::env::consts::ARCH {
        return Err(BackupError::InvalidArchive(format!(
            "this backup requires {architecture} VM support; this Silo build runs {} VMs",
            std::env::consts::ARCH
        )));
    }
    if manifest.schema_version != FORMAT_VERSION
        || manifest.runtime.name != "microsandbox"
        || manifest.runtime.version != "0.7.2"
        || manifest.runtime.snapshot_format != "msb-snapshot-tar-zstd-v0.7"
    {
        return Err(BackupError::InvalidArchive(
            "the runtime or package format is not supported".into(),
        ));
    }
    if manifest.sandboxes.is_empty() || manifest.sandboxes.len() > 64 {
        return Err(BackupError::InvalidArchive(
            "the sandbox count is outside supported limits".into(),
        ));
    }
    let mut names = HashSet::new();
    for sandbox in &manifest.sandboxes {
        validate_sandbox_name(&sandbox.name)
            .map_err(|_| BackupError::InvalidArchive("a sandbox name is invalid".into()))?;
        if !names.insert(&sandbox.name) {
            return Err(BackupError::InvalidArchive(
                "sandbox names must be unique".into(),
            ));
        }
        let config_size = serde_json::to_vec(&serde_json::json!({
            "runtimeConfig": sandbox.runtime_config,
            "machineConfig": sandbox.machine_config,
        }))
        .map_err(|_| BackupError::InvalidArchive("snapshot metadata is malformed".into()))?
        .len() as u64;
        if sandbox.payload_size == 0
            || !is_sha256(&sandbox.payload_sha256)
            || config_size > MAX_MANIFEST_BYTES
        {
            return Err(BackupError::InvalidArchive(
                "snapshot metadata is invalid".into(),
            ));
        }
        validate_snapshottable_config(&sandbox.name, &sandbox.runtime_config)
            .map_err(|error| BackupError::InvalidArchive(error.to_string()))?;
        validate_machine_config(&sandbox.name, &sandbox.machine_config)
            .map_err(|error| BackupError::InvalidArchive(error.to_string()))?;
        validate_package_volumes(&sandbox.volumes)?;
        validate_volume_contract(&sandbox.runtime_config, &sandbox.machine_config)?;
    }
    Ok(())
}

fn validate_package_volumes(volumes: &[Value]) -> Result<(), BackupError> {
    if !volumes.is_empty() {
        return Err(BackupError::InvalidArchive(
            "workspace disks must be carried by the MicroSandbox snapshot".into(),
        ));
    }
    Ok(())
}

fn validate_volume_sources(
    name: &str,
    runtime_config: &Value,
    machine_config: &Value,
) -> Result<(), BackupError> {
    validate_volume_contract(runtime_config, machine_config).map_err(|_| {
        BackupError::UnsupportedStorage(format!(
            "{name} disk metadata does not match its Silo VM configuration."
        ))
    })
}

fn validate_volume_contract(runtime_config: &Value, machine_config: &Value) -> Result<(), BackupError> {
    for (runtime_field, machine_field, multiplier) in [
        ("cpus", "cpus", 1),
        ("max_cpus", "maxCPUs", 1),
        ("memory_mib", "memoryGiB", 1024),
        ("max_memory_mib", "maxMemoryGiB", 1024),
    ] {
        let actual = runtime_config
            .get("resources")
            .and_then(|resources| resources.get(runtime_field))
            .and_then(Value::as_u64);
        let expected = machine_config
            .get(machine_field)
            .and_then(Value::as_u64)
            .and_then(|value| value.checked_mul(multiplier));
        if actual != expected || actual.is_none() {
            return Err(BackupError::InvalidArchive(
                "VM resources do not match the saved machine settings".into(),
            ));
        }
    }
    let workspace_mib = machine_config
        .get("workspaceStorageGiB")
        .and_then(Value::as_u64)
        .and_then(|size| size.checked_mul(1024));
    let owned_workspace = runtime_config
        .get("mounts")
        .and_then(Value::as_array)
        .is_some_and(|mounts| {
            mounts
                .iter()
                .filter(|mount| mount.get("guest").and_then(Value::as_str) == Some("/workspace"))
                .collect::<Vec<_>>()
                .as_slice()
                .iter()
                .any(|mount| {
                    mount["type"] == "Owned"
                        && mount.pointer("/storage/kind").and_then(Value::as_str) == Some("disk")
                        && mount
                            .pointer("/storage/capacity_mib")
                            .and_then(Value::as_u64)
                            == workspace_mib
                })
        });
    if !owned_workspace
        || runtime_config
            .pointer("/image/Oci/root_disk/size_mib")
            .and_then(Value::as_u64)
            != machine_config
                .get("runtimeStorageGiB")
                .and_then(Value::as_u64)
                .and_then(|size| size.checked_mul(1024))
    {
        return Err(BackupError::InvalidArchive(
            "VM disk capacities do not match the machine settings".into(),
        ));
    }
    let workspace_mounts = runtime_config
        .get("mounts")
        .and_then(Value::as_array)
        .ok_or_else(|| BackupError::InvalidArchive("VM mounts are missing".into()))?
        .iter()
        .filter(|mount| mount.get("guest").and_then(Value::as_str) == Some("/workspace"))
        .collect::<Vec<_>>();
    if workspace_mounts.len() != 1 {
        return Err(BackupError::InvalidArchive(
            "VM disk mounts do not match the machine settings".into(),
        ));
    }
    Ok(())
}

fn select_restore_source(
    manifest: &PackageManifest,
    selected: Option<&str>,
) -> Result<usize, BackupError> {
    match selected {
        Some(name) => manifest
            .sandboxes
            .iter()
            .position(|sandbox| sandbox.name == name)
            .ok_or_else(|| BackupError::InvalidRequest(format!("{name} is not in this backup."))),
        None if manifest.sandboxes.len() == 1 => Ok(0),
        None => Err(BackupError::InvalidRequest(
            "Choose which VM to restore from this multi-VM backup.".into(),
        )),
    }
}

fn validate_backup_request(request: &BackupRequest) -> Result<(), BackupError> {
    if request.sources.is_empty() || request.sources.len() > 64 {
        return Err(BackupError::InvalidRequest(
            "Choose between 1 and 64 VMs to back up.".into(),
        ));
    }
    if request
        .destination
        .extension()
        .and_then(|value| value.to_str())
        != Some("silo-backup")
    {
        return Err(BackupError::InvalidRequest(
            "The backup filename must end in .silo-backup.".into(),
        ));
    }
    if request.destination.exists() {
        return Err(BackupError::FileConflict(
            request.destination.display().to_string(),
        ));
    }
    let mut names = HashSet::new();
    if request
        .sources
        .iter()
        .any(|source| !names.insert(&source.name))
    {
        return Err(BackupError::InvalidRequest(
            "Each VM may appear only once in a backup.".into(),
        ));
    }
    Ok(())
}

fn validate_sandbox_name(name: &str) -> Result<(), BackupError> {
    let valid = !name.is_empty()
        && name.len() <= 32
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(BackupError::InvalidRequest(
            "VM names must start with a letter and contain only lowercase letters, numbers, and hyphens.".into(),
        ));
    }
    Ok(())
}

fn validate_machine_config(name: &str, config: &Value) -> Result<(), BackupError> {
    let object = config.as_object().ok_or_else(|| {
        BackupError::InvalidRequest(format!("{name} has invalid Silo VM metadata."))
    })?;
    const FIELDS: &[&str] = &[
        "kind",
        "id",
        "name",
        "cpus",
        "maxCPUs",
        "memoryGiB",
        "maxMemoryGiB",
        "workspaceStorageGiB",
        "runtimeStorageGiB",
    ];
    if object.len() != FIELDS.len() + usize::from(object.contains_key("desktop"))
        || object
            .keys()
            .any(|key| key != "desktop" && !FIELDS.contains(&key.as_str()))
        || object.get("desktop").is_some_and(|desktop| {
            serde_json::from_value::<crate::desktop::DesktopConfiguration>(desktop.clone()).is_err()
        })
        || object.get("kind").and_then(Value::as_str) != Some("vm")
        || object.get("name").and_then(Value::as_str) != Some(name)
        || object
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| uuid::Uuid::try_parse(id).is_err())
    {
        return Err(BackupError::InvalidRequest(format!(
            "{name} has invalid Silo VM metadata."
        )));
    }
    let number = |field: &str| object.get(field).and_then(Value::as_u64);
    let (
        Some(cpus),
        Some(max_cpus),
        Some(memory),
        Some(max_memory),
        Some(workspace),
        Some(runtime),
    ) = (
        number("cpus"),
        number("maxCPUs"),
        number("memoryGiB"),
        number("maxMemoryGiB"),
        number("workspaceStorageGiB"),
        number("runtimeStorageGiB"),
    )
    else {
        return Err(BackupError::InvalidRequest(format!(
            "{name} has invalid Silo VM metadata."
        )));
    };
    if cpus == 0
        || cpus > max_cpus
        || max_cpus > u8::MAX as u64
        || memory == 0
        || memory > max_memory
        || max_memory > u32::MAX as u64
        || workspace == 0
        || runtime == 0
        || workspace
            .checked_add(runtime)
            .and_then(|gib| gib.checked_mul(1024))
            .is_none_or(|mib| mib > u32::MAX as u64)
    {
        return Err(BackupError::InvalidRequest(format!(
            "{name} has invalid Silo VM metadata."
        )));
    }
    Ok(())
}

pub(crate) fn validate_snapshottable_config(name: &str, config: &Value) -> Result<(), BackupError> {
    let object = config.as_object().ok_or_else(|| {
        BackupError::UnsupportedStorage(format!(
            "{name} has no verified MicroSandbox configuration, so a complete backup cannot be created."
        ))
    })?;
    const ALLOWED_CONFIG_FIELDS: &[&str] = &[
        "name",
        "image",
        "resources",
        "runtime",
        "env",
        "labels",
        "rlimits",
        "mounts",
        "patches",
        "network",
        "vsock",
        "init",
        "pull_policy",
        "security_profile",
        "deployment_profile",
        "lifecycle",
        "manifest_digest",
    ];
    if object
        .keys()
        .any(|key| !ALLOWED_CONFIG_FIELDS.contains(&key.as_str()))
        || object.get("name").and_then(Value::as_str) != Some(name)
    {
        return Err(BackupError::UnsupportedStorage(format!(
            "{name} has a configuration this Silo build cannot restore safely."
        )));
    }
    if object.get("labels").is_some_and(|labels| {
        !labels.as_object().is_some_and(|labels| {
            labels.iter().all(|(key, value)| {
                !key.is_empty()
                    && !key.contains(['=', '\0'])
                    && value.as_str().is_some_and(|value| !value.contains('\0'))
            })
        })
    }) {
        return Err(BackupError::UnsupportedStorage(format!(
            "{name} has labels this Silo build cannot restore."
        )));
    }
    if object.get("env").is_some_and(|env| {
        !env.as_array().is_some_and(|env| {
            env.iter().all(|entry| {
                let key = entry.get("key").and_then(Value::as_str);
                let value = entry.get("value").and_then(Value::as_str);
                entry.as_object().is_some_and(|entry| entry.len() == 2)
                    && key.is_some_and(|key| !key.is_empty() && !key.contains(['=', '\0']))
                    && value.is_some_and(|value| !value.contains('\0'))
            })
        })
    }) || !supported_runtime_settings(object)
    {
        return Err(BackupError::UnsupportedStorage(format!(
            "{name} has runtime settings this Silo build cannot restore."
        )));
    }
    let mounts = object
        .get("mounts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            BackupError::UnsupportedStorage(format!(
            "{name} does not report its mounted storage, so a complete backup cannot be created."
        ))
        })?;
    if !silo_disk_mounts_with_optional_tmpfs(object, mounts) {
        return Err(BackupError::UnsupportedStorage(format!(
            "{name} does not use the Silo-owned workspace disk-image mount required for a complete backup."
        )));
    }
    if object
        .get("patches")
        .is_some_and(|patches| !patches.as_array().is_some_and(Vec::is_empty))
        || object
            .get("vsock")
            .is_some_and(|vsock| !vsock.as_object().is_some_and(serde_json::Map::is_empty))
        || object.get("network").is_some_and(network_uses_host_files)
    {
        return Err(BackupError::UnsupportedStorage(format!(
            "{name} uses host-linked configuration that this Silo build cannot restore safely."
        )));
    }
    let image = object
        .get("image")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            BackupError::UnsupportedStorage(format!(
                "{name} is not an OCI-rooted VM with a managed disk."
            ))
        })?;
    let oci = image.get("Oci").and_then(Value::as_object).ok_or_else(|| {
        BackupError::UnsupportedStorage(format!(
            "{name} is not an OCI-rooted VM with a managed disk."
        ))
    })?;
    match oci.get("root_disk") {
        None | Some(Value::Null) => Ok(()),
        Some(root) if root.get("kind").and_then(Value::as_str) == Some("managed") => Ok(()),
        Some(_) => Err(BackupError::UnsupportedStorage(format!(
            "{name} does not use the managed OCI root disk required by MicroSandbox 0.7.2 snapshots."
        ))),
    }
}

// Silo currently creates Ubuntu VMs with these runtime defaults. Reject overrides
// that the restore command does not reproduce instead of silently changing them.
// Only the exact credential-free profile installed during Silo VM creation is
// restorable here. Custom policies, host secret references and values stay blocked.
pub(crate) fn default_github_network(network: &Value) -> bool {
    let expected: Value =
        serde_json::from_str(include_str!("../guest/github-network-default.json"))
            .expect("checked-in GitHub network defaults");
    network == &expected
}

fn imported_deny_network(network: &Value) -> bool {
    let mut expected: Value =
        serde_json::from_str(include_str!("../guest/github-network-default.json"))
            .expect("checked-in GitHub network defaults");
    expected["policy"] = serde_json::json!({
        "default_egress": "deny",
        "default_ingress": "deny",
        "rules": []
    });
    network == &expected
}

fn supported_runtime_settings(config: &serde_json::Map<String, Value>) -> bool {
    // Preserve old VM backups so users can recover before migrating their account.
    if let Some(labels) = config.get("labels") {
        let Some(labels) = labels.as_object() else {
            return false;
        };
        if labels
            .get(crate::working_account::LABEL)
            .is_some_and(|version| version.as_str() != Some("1"))
        {
            return false;
        }
    }
    let expected = [
        (
            "runtime",
            serde_json::json!({"workdir":null,"shell":"/bin/sh","scripts":{},"entrypoint":null,"cmd":["/bin/bash"],"hostname":null,"user":null,"log_level":null,"metrics_sample_interval_ms":1000,"disable_metrics_sample":false}),
        ),
        (
            "network",
            serde_json::json!({"enabled":true,"ports":[],"interface":null,"policy":null,"dns":null,"tls":null,"secrets":null,"max_connections":null,"rate_limiter":null,"trust_host_cas":false,"outbound_proxy":null}),
        ),
        (
            "lifecycle",
            serde_json::json!({"ephemeral":false,"max_duration_secs":null,"idle_timeout_secs":null}),
        ),
    ];
    for (field, defaults) in expected {
        if let Some(value) = config.get(field) {
            if field == "network" && (default_github_network(value) || imported_deny_network(value)) {
                continue;
            }
            let Some(fields) = value.as_object() else {
                return false;
            };
            if fields.iter().any(|(key, value)| {
                if field == "runtime" && (key == "cmd" || key == "shell") && value.is_null() {
                    return false;
                }
                defaults.get(key) != Some(value)
            }) {
                return false;
            }
        }
    }
    for (field, default) in [
        ("security_profile", "default"),
        ("deployment_profile", "single_tenant"),
        ("pull_policy", "IfMissing"),
    ] {
        if config.get(field).is_some_and(|value| {
            value.as_str() != Some(default)
                && !(field == "pull_policy" && value.as_str() == Some("Never"))
        }) {
            return false;
        }
    }
    config.get("init").is_none_or(Value::is_null)
        && config
            .get("rlimits")
            .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty))
        && config
            .get("resources")
            .and_then(Value::as_object)
            .is_some_and(|resources| {
                resources.keys().all(|key| {
                    matches!(
                        key.as_str(),
                        "cpus" | "max_cpus" | "memory_mib" | "max_memory_mib"
                    )
                })
            })
}

fn silo_disk_mounts_with_optional_tmpfs(
    config: &serde_json::Map<String, Value>,
    mounts: &[Value],
) -> bool {
    let Some(memory_mib) = config
        .get("resources")
        .and_then(|resources| resources.get("memory_mib"))
        .and_then(Value::as_u64)
    else {
        return false;
    };
    let expected_size = (memory_mib / 4).clamp(1, 512);
    let disks = mounts
        .iter()
        .filter(|mount| mount.get("type").and_then(Value::as_str) == Some("Owned"))
        .collect::<Vec<_>>();
    if disks.len() != 1 || !disks.iter().all(|mount| valid_owned_workspace_mount(mount)) {
        return false;
    }
    let tmpfs = mounts
        .iter()
        .filter(|mount| mount.get("type").and_then(Value::as_str) == Some("Tmpfs"))
        .collect::<Vec<_>>();
    if mounts.len() != disks.len() + tmpfs.len() || tmpfs.len() > 1 {
        return false;
    }
    let Some(mount) = tmpfs.first() else {
        return true;
    };
    let Some(mount) = mount.as_object() else {
        return false;
    };
    const ALLOWED_TMPFS_FIELDS: &[&str] = &["type", "guest", "size_mib", "options"];
    if mount
        .keys()
        .any(|key| !ALLOWED_TMPFS_FIELDS.contains(&key.as_str()))
        || mount.get("type").and_then(Value::as_str) != Some("Tmpfs")
        || mount.get("guest").and_then(Value::as_str) != Some("/tmp")
        || mount.get("size_mib").and_then(Value::as_u64) != Some(expected_size)
    {
        return false;
    }
    let Some(options) = mount.get("options").and_then(Value::as_object) else {
        return false;
    };
    const ALLOWED_OPTION_FIELDS: &[&str] = &[
        "readonly",
        "noexec",
        "nosuid",
        "nodev",
        "override_uid",
        "override_gid",
    ];
    !options
        .keys()
        .any(|key| !ALLOWED_OPTION_FIELDS.contains(&key.as_str()))
        && ["readonly", "noexec", "nosuid", "nodev"]
            .iter()
            .all(|key| options.get(*key).and_then(Value::as_bool) == Some(false))
        && ["override_uid", "override_gid"]
            .iter()
            .all(|key| options.get(*key).is_none_or(Value::is_null))
}

fn valid_owned_workspace_mount(mount: &Value) -> bool {
    mount.get("type").and_then(Value::as_str) == Some("Owned")
        && mount.get("guest").and_then(Value::as_str) == Some("/workspace")
        && mount.pointer("/storage/kind").and_then(Value::as_str) == Some("disk")
        && mount
            .pointer("/storage/capacity_mib")
            .and_then(Value::as_u64)
            .is_some_and(|size| size > 0)
}

fn network_uses_host_files(network: &Value) -> bool {
    let Some(tls) = network.get("tls") else {
        return false;
    };
    tls.get("upstream_ca_cert")
        .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
        || tls
            .get("scoped_upstream_ca_cert")
            .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
        || tls
            .get("intercept_ca")
            .and_then(Value::as_object)
            .is_some_and(|ca| {
                ["cert_path", "key_path"]
                    .iter()
                    .any(|key| ca.get(*key).is_some_and(|value| !value.is_null()))
            })
}

fn extract_verified_payload(
    archive: &mut File,
    size: u64,
    expected_sha256: &str,
    destination: Option<PathBuf>,
    label: &str,
    cancellation: &Cancellation,
) -> Result<Option<PathBuf>, BackupError> {
    check_cancelled(cancellation)?;
    let mut remaining = size;
    let mut hasher = Sha256::new();
    let mut output = match destination {
        Some(path) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            Some((path, file))
        }
        None => None,
    };
    let mut buffer = [0_u8; 128 * 1024];
    while remaining > 0 {
        check_cancelled(cancellation)?;
        let wanted = remaining.min(buffer.len() as u64) as usize;
        archive
            .read_exact(&mut buffer[..wanted])
            .map_err(|_| BackupError::InvalidArchive(format!("the {label} is incomplete")))?;
        hasher.update(&buffer[..wanted]);
        if let Some((_, file)) = output.as_mut() {
            file.write_all(&buffer[..wanted])?;
        }
        remaining -= wanted as u64;
    }
    let digest = format!("sha256:{:x}", hasher.finalize());
    if digest != expected_sha256 {
        return Err(BackupError::InvalidArchive(format!(
            "the {label} failed its integrity check"
        )));
    }
    if let Some((path, file)) = output {
        file.sync_all()?;
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

/// Atomic promotion on external filesystems, without requiring hard-link support.
fn rename_without_replacing(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid source path"))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid destination path"))?;
    // SAFETY: both paths are valid NUL-terminated strings; the flags prohibit replacement.
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn write_immutable_package(
    destination: &Path,
    manifest: &PackageManifest,
    payloads: &[&Path],
    cancellation: &Cancellation,
    token: Option<&str>,
) -> Result<u64, BackupError> {
    let parent = destination.parent().ok_or_else(|| {
        BackupError::InvalidRequest("The backup destination has no parent directory.".into())
    })?;
    fs::create_dir_all(parent)?;
    let manifest_bytes = serde_json::to_vec(manifest)?;
    if manifest_bytes.is_empty() || manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(BackupError::InvalidRequest(
            "Backup metadata exceeds the supported size.".into(),
        ));
    }
    let prefix = token
        .map(|token| format!(".silo-backup-{token}-"))
        .unwrap_or_else(|| ".silo-backup-".into());
    let mut temporary = tempfile::Builder::new()
        .prefix(&prefix)
        .tempfile_in(parent)?;
    temporary.write_all(MAGIC)?;
    temporary.write_all(&FORMAT_VERSION.to_be_bytes())?;
    temporary.write_all(&(manifest_bytes.len() as u64).to_be_bytes())?;
    temporary.write_all(&manifest_bytes)?;
    let mut buffer = [0_u8; 128 * 1024];
    for payload in payloads {
        let mut input = File::open(payload)?;
        loop {
            check_cancelled(cancellation)?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            temporary.write_all(&buffer[..count])?;
        }
    }
    temporary.as_file().sync_all()?;
    // Verify all written bytes before the atomic commit. Cancellation cannot turn
    // an already-published, verified archive into a reported cancellation.
    let verified = read_and_verify_package(
        temporary.path(),
        DEFAULT_MAX_ARCHIVE_BYTES,
        cancellation,
        None,
    )?;
    let size_bytes = verified.size_bytes;
    check_cancelled(cancellation)?;
    rename_without_replacing(temporary.path(), destination).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            BackupError::FileConflict(destination.display().to_string())
        } else {
            BackupError::Io(error)
        }
    })?;
    if let Err(error) = File::open(parent).and_then(|directory| directory.sync_all()) {
        let _ = fs::remove_file(destination);
        return Err(BackupError::Io(error));
    }
    Ok(size_bytes)
}

fn hash_regular_file(
    path: &Path,
    max_bytes: u64,
    cancellation: &Cancellation,
) -> Result<(u64, String), BackupError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Err(BackupError::InvalidArchive(
            "the runtime did not create a regular snapshot archive".into(),
        ));
    }
    if metadata.len() > max_bytes {
        return Err(BackupError::InvalidArchive(
            "the snapshot archive exceeds the configured safety limit".into(),
        ));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        check_cancelled(cancellation)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok((metadata.len(), format!("sha256:{:x}", hasher.finalize())))
}

fn read_u32(reader: &mut impl Read) -> Result<u32, BackupError> {
    let mut bytes = [0_u8; 4];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| BackupError::InvalidArchive("the file header is incomplete".into()))?;
    Ok(u32::from_be_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> Result<u64, BackupError> {
    let mut bytes = [0_u8; 8];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| BackupError::InvalidArchive("the file header is incomplete".into()))?;
    Ok(u64::from_be_bytes(bytes))
}

fn check_cancelled(cancellation: &Cancellation) -> Result<(), BackupError> {
    if cancellation.cancelled() {
        Err(BackupError::Cancelled)
    } else {
        Ok(())
    }
}

fn is_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn unique_suffix() -> String {
    format!("{}-{}", std::process::id(), now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<Vec<String>>>,
        existing: Mutex<Vec<String>>,
        /// Pre-captured `(group, member)` snapshots published by `snapshot list`,
        /// so a checkpoint export can locate a member without a fresh capture.
        existing_members: Mutex<Vec<(String, String)>>,
        fail_start: AtomicBool,
        fail_running_verification: AtomicBool,
        fail_load: AtomicBool,
        fail_save: AtomicBool,
        invalid_import_head: AtomicBool,
        cancel_after_snapshot: AtomicBool,
    }

    impl MsbRunner for FakeRunner {
        fn run(
            &self,
            command: &MsbCommand,
            arguments: &[String],
            _timeout: Duration,
            cancellation: &Cancellation,
        ) -> Result<CommandOutput, BackupError> {
            check_cancelled(cancellation)?;
            self.calls.lock().unwrap().push(arguments.to_vec());
            let success = || CommandOutput {
                status: ExitStatus::from_raw(0),
                stdout: String::new(),
                stderr: String::new(),
            };
            match arguments
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
            {
                ["snapshot", "create", _, "--from-sandbox", _, "--group", group, "--guest-flush", _, "--integrity", "--quiet"] =>
                {
                    let snapshot = command.home.join("snapshots").join(group).join("snap_00000000000000000000000000000000");
                    fs::create_dir_all(&snapshot)?;
                    fs::write(snapshot.join("snapshot.json"), b"{}")?;
                    if self.cancel_after_snapshot.load(Ordering::Acquire) {
                        cancellation.cancel();
                    }
                    Ok(success())
                }
                ["snapshot", "verify", _] => Ok(success()),
                ["inspect", _, "--format", "json"] => Ok(CommandOutput {
                    status: ExitStatus::from_raw(0),
                    stdout: serde_json::json!({"status": if self.fail_running_verification.load(Ordering::Acquire) {"Stopped"} else {"Running"}}).to_string(),
                    stderr: String::new(),
                }),
                ["snapshot", "save", _, output, "--with-parents", "--with-image"] => {
                    if self.fail_save.load(Ordering::Acquire) {
                        return Ok(CommandOutput {
                            status: ExitStatus::from_raw(1 << 8),
                            stderr: "simulated archive write failure".into(),
                            ..success()
                        });
                    }
                    fs::write(output, b"\x28\xb5\x2f\xfdself-contained snapshot")?;
                    Ok(success())
                }
                ["snapshot", "load", _, "--group", group] => {
                    if self.fail_load.load(Ordering::Acquire) {
                        fs::create_dir_all(
                            command.home.join("cache/tmp/snapshot-import-interrupted"),
                        )?;
                        return Ok(CommandOutput {
                            status: ExitStatus::from_raw(1 << 8),
                            stderr: "unsafe archive member".into(),
                            ..success()
                        });
                    }
                    Ok(CommandOutput {
                        stdout: format!("sha256:fake\n{group}:imported-member\n"),
                        ..success()
                    })
                }
                ["snapshot", "list", "--format", "json"] => {
                    let calls = self.calls.lock().unwrap();
                    let mut entries = Vec::new();
                    for (group, member) in self.existing_members.lock().unwrap().iter() {
                        let snapshot = command
                            .home
                            .join("snapshots")
                            .join(group)
                            .join("snap_00000000000000000000000000000000");
                        fs::create_dir_all(&snapshot)?;
                        fs::write(snapshot.join("snapshot.json"), b"{}")?;
                        entries.push(serde_json::json!({
                            "group": group,
                            "name": member,
                            "availability": "ready",
                            "snapshot_id": "snap_00000000000000000000000000000000",
                            "artifact_path": snapshot
                        }));
                    }
                    if let Some(create) = calls.iter().rev().find(|call| call.get(1).is_some_and(|part| part == "create")) {
                        let group = &create[6];
                        entries.push(serde_json::json!({
                            "group": group,
                            "name": create[2],
                            "availability": "ready",
                            "snapshot_id": "snap_00000000000000000000000000000000",
                            "artifact_path": command.home.join("snapshots").join(group).join("snap_00000000000000000000000000000000")
                        }));
                    }
                    if let Some(load) = calls.iter().rev().find(|call| call.get(1).is_some_and(|part| part == "load")) {
                        entries.push(serde_json::json!({"group":load.last().unwrap(),"name":"imported-parent","availability":"ready","snapshot_id":"snap_00000000000000000000000000000000"}));
                        entries.push(serde_json::json!({"group":load.last().unwrap(),"name":"imported-member","availability":"ready","snapshot_id":"snap_11111111111111111111111111111111"}));
                    }
                    Ok(CommandOutput {
                        stdout: serde_json::to_string(&entries)?,
                        ..success()
                    })
                }
                ["snapshot", "head", group, "--format", "json"] => Ok(CommandOutput {
                    stdout: serde_json::json!({
                        "group": group,
                        "head": if self.invalid_import_head.load(Ordering::Acquire) {
                            "snap_22222222222222222222222222222222"
                        } else {
                            "snap_11111111111111111111111111111111"
                        }
                    }).to_string(),
                    ..success()
                }),
                ["list", "--format", "json"] => {
                    let rows = self
                        .existing
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|name| serde_json::json!({"name": name}))
                        .collect::<Vec<_>>();
                    Ok(CommandOutput {
                        stdout: serde_json::to_string(&rows)?,
                        ..success()
                    })
                }
                ["start", _] if self.fail_start.load(Ordering::Acquire) => Ok(CommandOutput {
                    status: ExitStatus::from_raw(1 << 8),
                    stderr: "restart refused".into(),
                    ..success()
                }),
                _ => Ok(success()),
            }
        }
    }

    fn managed_config(name: &str) -> Value {
        serde_json::json!({
            "name": name,
            "labels": {"silo.working-account":"1"},
            "image": {"Oci": {"reference": "alpine:3.20", "root_disk": {"kind": "managed", "size_mib": 81920}}},
            "mounts": [
                {
                    "type": "Owned",
                    "guest": "/workspace",
                    "storage": {"kind":"disk", "capacity_mib":61440},
                    "options": {"readonly": false, "noexec": false, "nosuid": false, "nodev": false}
                }
            ],
            "resources": {"cpus": 4, "max_cpus":6, "memory_mib": 16384, "max_memory_mib":32768}
        })
    }

    fn managed_config_with_default_tmpfs(name: &str) -> Value {
        let mut config = managed_config(name);
        config["mounts"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type": "Tmpfs",
                "guest": "/tmp",
                "size_mib": 512,
                "options": {
                    "readonly": false,
                    "noexec": false,
                    "nosuid": false,
                    "nodev": false
                }
            }));
        config
    }

    #[test]
    fn backup_preserves_optional_desktop_preferences_and_rejects_unknown_settings() {
        let mut config = machine_config("dev");
        assert!(validate_machine_config("dev", &config).is_ok());
        config["desktop"] = serde_json::json!({"startWithSandbox":false});
        validate_machine_config("dev", &config).unwrap();
        let decoded: crate::runtime::MachineConfiguration =
            serde_json::from_value(config.clone()).unwrap();
        assert_eq!(
            crate::desktop::configuration(&decoded)
                .unwrap()
                .start_with_sandbox,
            false
        );
        assert_eq!(serde_json::to_value(decoded).unwrap(), config);
        config["desktop"]["password"] = serde_json::json!("unexpected");
        assert!(validate_machine_config("dev", &config).is_err());
        config["desktop"] = serde_json::json!({"startWithSandbox":"false"});
        assert!(validate_machine_config("dev", &config).is_err());
    }

    fn machine_config(name: &str) -> Value {
        serde_json::json!({
            "kind": "vm",
            "id": "2f6b739d-ff7a-4be8-aa5e-f6694e4ab0d8",
            "name": name,
            "cpus": 4,
            "maxCPUs": 6,
            "memoryGiB": 16,
            "maxMemoryGiB": 32,
            "workspaceStorageGiB": 60,
            "runtimeStorageGiB": 80
        })
    }

    fn service(temp: &tempfile::TempDir, runner: FakeRunner) -> BackupService<FakeRunner> {
        BackupService::with_runner(
            MsbCommand {
                metadata: temp.path().join("machines.json"),
                executable: temp.path().join("msb"),
                home: temp.path().join("home"),
                storage_home: None,
                library: temp.path().join("libkrunfw"),
            },
            temp.path().join("scratch"),
            runner,
        )
    }

    fn create_one(
        service: &BackupService<FakeRunner>,
        destination: PathBuf,
        running: bool,
    ) -> Result<BackupResult, BackupError> {
        create_one_in_group(service, destination, running, "dev")
    }

    fn create_one_in_group(
        service: &BackupService<FakeRunner>,
        destination: PathBuf,
        running: bool,
        snapshot_group: &str,
    ) -> Result<BackupResult, BackupError> {
        let runtime_config = managed_config("dev");
        service.create_backup(
            BackupRequest {
                destination,
                sources: vec![BackupSource {
                    name: "dev".into(),
                    snapshot_group: snapshot_group.into(),
                    was_running: running,
                    runtime_config,
                    machine_config: machine_config("dev"),
                    existing_member: None,
                }],
            },
            &Cancellation::default(),
        )
    }

    fn script_command(directory: &Path, script: &str) -> MsbCommand {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("msb");
        let home = directory.join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        MsbCommand {
            metadata: directory.join("machines.json"),
            executable,
            home,
            storage_home: None,
            library: directory.join("unused-library"),
        }
    }

    fn wait_for_file(path: &Path) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        path.exists()
    }

    #[test]
    fn snapshot_command_keeps_recovery_out_until_it_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let command = script_command(
            directory.path(),
            "#!/bin/sh\nprintf ready > \"$MSB_HOME/ready\"\nwhile [ ! -e \"$MSB_HOME/release\" ]; do sleep 0.02; done\n",
        );
        let home = command.home.clone();
        let worker = thread::spawn(move || {
            SystemMsbRunner.run(
                &command,
                &["snapshot".into(), "load".into(), "/tmp/unused.msb".into()],
                Duration::from_secs(5),
                &Cancellation::default(),
            )
        });
        let ready = wait_for_file(&home.join("ready"));
        let lock_result = wait_for_interrupted_command(&home, Duration::ZERO);
        fs::write(home.join("release"), b"release").unwrap();
        let result = worker.join().unwrap();
        assert!(ready, "snapshot command never reached its side effect");
        assert_eq!(lock_result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(result.unwrap().status.success());
    }

    #[test]
    fn non_snapshot_commands_do_not_take_the_worker_lock() {
        let directory = tempfile::tempdir().unwrap();
        let command = script_command(
            directory.path(),
            "#!/bin/sh\nprintf ready > \"$MSB_HOME/ready\"\nwhile [ ! -e \"$MSB_HOME/release\" ]; do sleep 0.02; done\nprintf '[]'\n",
        );
        let home = command.home.clone();
        let worker = thread::spawn(move || {
            SystemMsbRunner.run(
                &command,
                &["list".into(), "--format".into(), "json".into()],
                Duration::from_secs(5),
                &Cancellation::default(),
            )
        });
        let ready = wait_for_file(&home.join("ready"));
        let lock_result = wait_for_interrupted_command(&home, Duration::ZERO);
        fs::write(home.join("release"), b"release").unwrap();
        assert!(ready);
        assert!(lock_result.is_ok(), "a read-only list must not hold the worker lock");
        assert_eq!(worker.join().unwrap().unwrap().stdout, "[]");
    }

    #[test]
    fn surviving_child_holds_worker_lock_until_it_exits() {
        let directory = tempfile::tempdir().unwrap();
        let lock = wait_for_interrupted_command(directory.path(), Duration::ZERO).unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read line"]).stdin(Stdio::piped());
        inherit_worker_lock(&mut command, &lock);
        let mut child = command.spawn().unwrap();
        drop(lock); // The original Silo process no longer owns a descriptor.
        let blocked = wait_for_interrupted_command(directory.path(), Duration::ZERO);
        drop(child.stdin.take());
        child.wait().unwrap();
        assert_eq!(blocked.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(wait_for_interrupted_command(directory.path(), Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn backup_contract_requires_owned_workspace_snapshot_and_real_root_capacity() {
        let config = managed_config("dev");
        let machine = machine_config("dev");
        assert!(validate_volume_contract(&config, &machine).is_ok());
        let mut wrong_root = config.clone();
        wrong_root["image"]["Oci"]["root_disk"]["size_mib"] = Value::from(8192);
        assert!(validate_volume_contract(&wrong_root, &machine).is_err());
        let mut extra_disk = config;
        extra_disk["mounts"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"type":"DiskImage", "guest":"/extra"}));
        assert!(validate_snapshottable_config("dev", &extra_disk).is_err());
        assert!(validate_package_volumes(&[]).is_ok());
        assert!(
            validate_package_volumes(&[serde_json::json!({
                "role": "workspace",
                "mountPath": "/workspace",
                "capacityBytes": 1,
                "logicalSizeBytes": 1,
                "payloadSize": 1,
                "payloadSha256": format!("sha256:{}", "0".repeat(64)),
            })])
            .is_err()
        );
    }

    #[test]
    fn incompatible_guest_architecture_is_rejected_before_restore() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("architecture.silo-backup");
        create_one(
            &service(&temp, FakeRunner::default()),
            destination.clone(),
            false,
        )
        .unwrap();
        let mut package = read_and_verify_package(
            &destination,
            DEFAULT_MAX_ARCHIVE_BYTES,
            &Cancellation::default(),
            None,
        )
        .unwrap();
        package.manifest.runtime.guest_architecture = if std::env::consts::ARCH == "aarch64" {
            "x86_64"
        } else {
            "aarch64"
        }
        .into();
        let error = validate_manifest(&package.manifest).unwrap_err();
        assert!(error.to_string().contains("this backup requires"));
    }

    #[test]
    fn backup_is_immutable_verified_and_self_contained() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let service = service(&temp, FakeRunner::default());
        let result = create_one(&service, destination.clone(), false).unwrap();
        assert!(result.restart_failures.is_empty());
        let inspection = service
            .inspect_archive(&destination, &Cancellation::default())
            .unwrap();
        assert_eq!(inspection.sandboxes, ["dev"]);
        assert_eq!(inspection.size_bytes, result.size_bytes);
        let first = fs::read(&destination).unwrap();
        let conflict = create_one(&service, destination.clone(), false);
        assert!(matches!(conflict, Err(BackupError::FileConflict(_))));
        let message = conflict.err().unwrap().to_string();
        assert!(message.starts_with("A file already exists at "), "{message}");
        assert!(!message.contains("VM named"), "{message}");
        assert_eq!(fs::read(destination).unwrap(), first);
        let calls = service.runner.calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|args| args.ends_with(&["--with-parents".into(), "--with-image".into()]))
        );
    }

    #[test]
    fn checkpoint_export_reuses_the_existing_member_without_capturing() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev-checkpoint.silo-backup");
        let member = "c0123456789abcdef0123456789abcde";
        let runner = FakeRunner::default();
        runner
            .existing_members
            .lock()
            .unwrap()
            .push(("dev".into(), member.into()));
        let service = service(&temp, runner);
        let result = service
            .create_backup(
                BackupRequest {
                    destination: destination.clone(),
                    sources: vec![BackupSource {
                        name: "dev".into(),
                        snapshot_group: "dev".into(),
                        // Irrelevant on the checkpoint path: no fresh capture runs.
                        was_running: true,
                        runtime_config: managed_config("dev"),
                        machine_config: machine_config("dev"),
                        existing_member: Some(member.into()),
                    }],
                },
                &Cancellation::default(),
            )
            .unwrap();
        assert!(result.restart_failures.is_empty());
        assert!(destination.is_file());
        let calls = service.runner.calls.lock().unwrap();
        // No fresh snapshot capture was taken.
        assert!(calls
            .iter()
            .all(|args| args.get(1).map(String::as_str) != Some("create")));
        // The existing member was verified and saved self-contained.
        assert!(calls
            .iter()
            .any(|args| matches!(args.as_slice(), [head, verb, ..] if head == "snapshot" && verb == "verify")));
        assert!(calls
            .iter()
            .any(|args| args.ends_with(&["--with-parents".into(), "--with-image".into()])));
    }

    #[test]
    fn running_vm_is_snapshotted_live_with_required_guest_flush() {
        let temp = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let service = service(&temp, runner);
        let result = create_one(&service, temp.path().join("dev.silo-backup"), true).unwrap();
        assert!(result.restart_failures.is_empty());
        assert!(result.destination.is_file());
        let calls = service.runner.calls.lock().unwrap();
        let capture = calls
            .iter()
            .position(|args| args.get(1).is_some_and(|arg| arg == "create"))
            .unwrap();
        let archive = calls
            .iter()
            .position(|args| args.get(1).is_some_and(|arg| arg == "save"))
            .unwrap();
        assert!(capture < archive);
        assert!(
            calls[capture]
                .windows(2)
                .any(|pair| pair[0] == "--guest-flush" && pair[1] == "required")
        );
        assert!(!calls.iter().any(|args| {
            args.first()
                .is_some_and(|arg| arg == "stop" || arg == "start")
        }));
    }

    #[test]
    fn backup_capture_uses_the_saved_lineage_group() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(&temp, FakeRunner::default());
        let group = "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9";
        create_one_in_group(&service, temp.path().join("dev.silo-backup"), false, group)
            .unwrap();
        let calls = service.runner.calls.lock().unwrap();
        let capture = calls
            .iter()
            .find(|args| args.get(1).is_some_and(|arg| arg == "create"))
            .unwrap();
        assert!(capture.windows(2).any(|pair| pair == ["--group", group]));
        assert!(!capture[6].starts_with("silo-export-"));
    }

    #[test]
    fn default_github_network_is_restorable_but_credentials_and_policy_changes_are_not() {
        let mut config = managed_config("dev");
        config["network"] =
            serde_json::from_str(include_str!("../guest/github-network-default.json")).unwrap();
        assert!(validate_snapshottable_config("dev", &config).is_ok());
        let original = config.clone();
        config["network"]["secrets"]["secrets"][0]["value"] =
            serde_json::json!("must-not-be-archived");
        assert!(validate_snapshottable_config("dev", &config).is_err());
        config = original.clone();
        config["network"]["tls"]["verify_upstream"] = serde_json::json!(false);
        assert!(validate_snapshottable_config("dev", &config).is_err());
        config = original;
        config["network"]["secrets"]["secrets"][0]["source"] =
            serde_json::json!({"kind":"file","path":"/private/secret"});
        assert!(validate_snapshottable_config("dev", &config).is_err());
    }

    #[test]
    fn imported_deny_network_is_restorable_but_custom_rules_are_not() {
        let mut config = managed_config("dev");
        config["network"] =
            serde_json::from_str(include_str!("../guest/github-network-default.json")).unwrap();
        config["network"]["policy"] = serde_json::json!({
            "default_egress": "deny",
            "default_ingress": "deny",
            "rules": []
        });

        assert!(validate_snapshottable_config("dev", &config).is_ok());

        config["network"]["policy"]["rules"] = serde_json::json!([{
            "action": "allow",
            "destination": {"group": "public"},
            "direction": "egress",
            "ports": [],
            "protocols": []
        }]);
        assert!(validate_snapshottable_config("dev", &config).is_err());

        config["network"]["policy"] = serde_json::json!({
            "default_egress": "allow",
            "default_ingress": "deny",
            "rules": []
        });
        assert!(validate_snapshottable_config("dev", &config).is_err());
    }

    #[test]
    fn working_account_backup_accepts_supported_policies_only() {
        let mut config = managed_config("dev");
        config["labels"] = serde_json::json!({"silo.working-account":"1"});
        assert!(validate_snapshottable_config("dev", &config).is_ok());
        config["labels"]["silo.working-account"] = serde_json::json!("unknown");
        assert!(validate_snapshottable_config("dev", &config).is_err());
    }

    #[test]
    fn unsupported_runtime_overrides_cannot_be_backed_up_as_restorable() {
        for (field, value) in [
            ("network", serde_json::json!({"enabled":false})),
            ("runtime", serde_json::json!({"workdir":"/custom"})),
            ("security_profile", serde_json::json!("restricted")),
            ("lifecycle", serde_json::json!({"ephemeral":true})),
        ] {
            let mut config = managed_config("dev");
            config[field] = value;
            assert!(
                validate_snapshottable_config("dev", &config).is_err(),
                "{field}"
            );
        }
        let mut config = managed_config("dev");
        config["env"] = serde_json::json!([{"key":"GIT_AUTHOR_NAME", "value":"Silo Test"}]);
        assert!(validate_snapshottable_config("dev", &config).is_ok());
    }

    #[test]
    fn mounts_and_non_managed_roots_block_complete_backup() {
        assert!(
            validate_snapshottable_config("dev", &managed_config_with_default_tmpfs("dev")).is_ok()
        );
        let mut mounted = managed_config("dev");
        mounted["mounts"] = serde_json::json!([{"type": "Named", "name": "data"}]);
        assert!(matches!(
            validate_snapshottable_config("dev", &mounted),
            Err(BackupError::UnsupportedStorage(_))
        ));
        let mut flat = managed_config("dev");
        flat["image"]["Oci"]["root_disk"]["kind"] = Value::String("flat".into());
        assert!(matches!(
            validate_snapshottable_config("dev", &flat),
            Err(BackupError::UnsupportedStorage(_))
        ));
    }

    #[test]
    fn cancellation_leaves_no_final_or_partial_file() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let service = service(&temp, FakeRunner::default());
        let cancellation = Cancellation::default();
        cancellation.cancel();
        assert!(matches!(
            service.create_backup(
                BackupRequest {
                    destination: destination.clone(),
                    sources: vec![BackupSource {
                        name: "dev".into(),
                        snapshot_group: "dev".into(),
                        was_running: false,
                        runtime_config: managed_config("dev"),
                        machine_config: machine_config("dev"),
                        existing_member: None,
                    }],
                },
                &cancellation,
            ),
            Err(BackupError::Cancelled)
        ));
        assert!(!destination.exists());
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".silo-backup-")
        }));
    }

    #[test]
    fn cancelled_capture_does_not_publish_an_archive_or_stop_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let runner = FakeRunner::default();
        runner.cancel_after_snapshot.store(true, Ordering::Release);
        let service = service(&temp, runner);
        assert!(matches!(
            create_one(&service, destination.clone(), true),
            Err(BackupError::Cancelled)
        ));
        assert!(!destination.exists());
        let captures = fs::read_dir(service.command.home.join("snapshots")).unwrap();
        assert_eq!(captures.count(), 1, "captured ancestry must survive cancellation");
        let calls = service.runner.calls.lock().unwrap();
        assert!(!calls.iter().any(|arguments| {
            arguments
                .first()
                .is_some_and(|arg| arg == "stop" || arg == "start")
        }));
    }

    #[test]
    fn failed_archive_keeps_native_capture_for_the_next_export() {
        let temp = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        runner.fail_save.store(true, Ordering::Release);
        let service = service(&temp, runner);
        let first = temp.path().join("failed.silo-backup");
        assert!(matches!(
            create_one(&service, first.clone(), false),
            Err(BackupError::CommandFailed { .. })
        ));
        assert!(!first.exists());
        assert!(fs::read_dir(service.command.home.join("snapshots")).unwrap().count() > 0);
        service.runner.fail_save.store(false, Ordering::Release);
        create_one(&service, temp.path().join("retry.silo-backup"), false).unwrap();
        let calls = service.runner.calls.lock().unwrap();
        assert_eq!(calls.iter().filter(|args| args.get(1).is_some_and(|arg| arg == "create")).count(), 2);
        assert!(!calls.iter().any(|args| args.get(1).is_some_and(|arg| arg == "remove")));
        assert!(calls.iter().all(|args| !args.iter().any(|arg| arg == "--dest-dir")));
    }

    #[test]
    fn growing_native_snapshot_index_is_complete_or_explicitly_rejected() {
        let rows: Vec<_> = (0..600)
            .map(|index| serde_json::json!({
                "group": "linux-legacy-source",
                "name": format!("checkpoint-{index}"),
                "availability": "ready",
                "artifact_path": format!("/runtime/snapshots/linux-legacy-source/snap_{index:032x}"),
            }))
            .collect();
        let index = serde_json::to_vec(&rows).unwrap();
        assert!(index.len() > MAX_COMMAND_OUTPUT);
        let (complete, truncated) = read_output(index.as_slice(), MAX_SNAPSHOT_INDEX_OUTPUT, false).unwrap();
        assert!(!truncated);
        assert_eq!(serde_json::from_slice::<Vec<Value>>(&complete).unwrap().len(), rows.len());
        let oversized = vec![b'x'; MAX_SNAPSHOT_INDEX_OUTPUT + 1];
        let (_, truncated) = read_output(oversized.as_slice(), MAX_SNAPSHOT_INDEX_OUTPUT, false).unwrap();
        assert!(truncated, "oversized structured output must fail before JSON parsing");
        let (tail, truncated) = read_output(index.as_slice(), MAX_COMMAND_OUTPUT, true).unwrap();
        assert!(truncated);
        assert_eq!(tail.len(), MAX_COMMAND_OUTPUT);
    }

    #[test]
    fn corrupt_and_truncated_archives_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let service = service(&temp, FakeRunner::default());
        create_one(&service, destination.clone(), false).unwrap();
        let mut bytes = fs::read(&destination).unwrap();
        *bytes.last_mut().unwrap() ^= 0xff;
        let corrupt = temp.path().join("corrupt.silo-backup");
        fs::write(&corrupt, &bytes).unwrap();
        assert!(matches!(
            service.inspect_archive(&corrupt, &Cancellation::default()),
            Err(BackupError::InvalidArchive(_))
        ));
        bytes.truncate(bytes.len() - 4);
        let truncated = temp.path().join("truncated.silo-backup");
        fs::write(&truncated, bytes).unwrap();
        assert!(matches!(
            service.inspect_archive(&truncated, &Cancellation::default()),
            Err(BackupError::InvalidArchive(_))
        ));
    }

    #[test]
    fn previous_archive_generation_is_rejected_without_legacy_reader() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let service = service(&temp, FakeRunner::default());
        create_one(&service, destination.clone(), false).unwrap();
        let mut bytes = fs::read(&destination).unwrap();
        bytes[MAGIC.len()..MAGIC.len() + 4].copy_from_slice(&2_u32.to_be_bytes());
        let old = temp.path().join("old.silo-backup");
        fs::write(&old, bytes).unwrap();
        let error = service
            .inspect_archive(&old, &Cancellation::default())
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("format version 2 is not supported")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_archive_is_rejected_without_following_it() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let service = service(&temp, FakeRunner::default());
        create_one(&service, destination.clone(), false).unwrap();
        let link = temp.path().join("linked.silo-backup");
        std::os::unix::fs::symlink(&destination, &link).unwrap();
        assert!(matches!(
            service.inspect_archive(&link, &Cancellation::default()),
            Err(BackupError::InvalidArchive(_))
        ));
    }

    #[test]
    fn restore_rejects_conflict_and_imports_a_verified_pending_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let runner = FakeRunner::default();
        runner.existing.lock().unwrap().push("taken".into());
        let service = service(&temp, runner);
        create_one(&service, destination.clone(), false).unwrap();
        assert!(matches!(
            service.prepare_restore(
                RestoreRequest {
                    archive: destination.clone(),
                    source_name: None,
                    new_name: "taken".into(),
                },
                &Cancellation::default(),
            ),
            Err(BackupError::Conflict(name)) if name == "taken"
        ));
        let restored = service
            .prepare_restore(
                RestoreRequest {
                    archive: destination,
                    source_name: None,
                    new_name: "dev-restored".into(),
                },
                &Cancellation::default(),
            )
            .unwrap();
        assert_eq!(restored.source_name, "dev");
        assert_eq!(restored.new_name, "dev-restored");
        assert_eq!(restored.runtime_config["name"], "dev");
        assert_eq!(restored.machine_config["workspaceStorageGiB"], 60);
        assert_eq!(restored.machine_config["runtimeStorageGiB"], 80);
        assert!(restored.snapshot_group.starts_with("silo-import-"));
        assert_eq!(restored.snapshot_member, "imported-member");
        let calls = service.runner.calls.lock().unwrap();
        assert!(!calls.iter().any(|arguments| {
            arguments
                .first()
                .is_some_and(|arg| arg == "restore" || arg == "start")
        }));
        drop(calls);
        let stage_root = restored._stage.path().to_path_buf();
        drop(restored);
        assert!(!stage_root.exists());
    }

    #[test]
    fn restore_rejects_an_import_head_absent_from_the_parent_chain() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let service = service(&temp, FakeRunner::default());
        create_one(&service, destination.clone(), false).unwrap();
        service.runner.invalid_import_head.store(true, Ordering::Release);
        let result = service.prepare_restore(
            RestoreRequest {
                archive: destination,
                source_name: None,
                new_name: "dev-restored".into(),
            },
            &Cancellation::default(),
        );
        assert!(matches!(result, Err(BackupError::InvalidArchive(message)) if message.contains("head is not uniquely indexed")));
        let calls = service.runner.calls.lock().unwrap();
        assert!(!calls.iter().any(|args| args.get(1).is_some_and(|arg| arg == "verify")
            && args.iter().any(|arg| arg.starts_with("silo-import-"))));
    }

    #[test]
    fn failed_runtime_load_rolls_back_private_restore_stage() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("dev.silo-backup");
        let runner = FakeRunner::default();
        let service = service(&temp, runner);
        create_one(&service, destination.clone(), false).unwrap();
        let existing_cache_stage = temp
            .path()
            .join("home/cache/tmp/snapshot-import-preexisting");
        fs::create_dir_all(&existing_cache_stage).unwrap();
        service.runner.fail_load.store(true, Ordering::Release);
        let result = service.prepare_restore(
            RestoreRequest {
                archive: destination,
                source_name: None,
                new_name: "dev-restored".into(),
            },
            &Cancellation::default(),
        );
        assert!(matches!(result, Err(BackupError::CommandFailed { .. })));
        let scratch = temp.path().join("scratch");
        assert!(fs::read_dir(scratch).unwrap().next().is_none());
        assert!(existing_cache_stage.is_dir());
        assert!(
            !temp
                .path()
                .join("home/cache/tmp/snapshot-import-interrupted")
                .exists()
        );
    }

    #[test]
    fn manifest_does_not_allow_path_like_sandbox_names() {
        assert!(validate_sandbox_name("../victim").is_err());
        assert!(validate_sandbox_name("/absolute").is_err());
        assert!(validate_sandbox_name("valid-name").is_ok());
    }

}
