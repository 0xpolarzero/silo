use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAGIC: &[u8; 16] = b"SILO-BACKUP\0\0\0\0\0";
const FORMAT_VERSION: u32 = 2;
const SPARSE_MAGIC: &[u8; 16] = b"SILO-SPARSE\0\0\0\0\0";
const SPARSE_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_COMMAND_OUTPUT: usize = 32 * 1024;
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DEFAULT_MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MsbCommand {
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
        let mut child = Command::new(&command.executable)
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
        let stdout_reader = thread::spawn(move || read_output(stdout));
        let stderr_reader = thread::spawn(move || read_output(stderr));
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
                let stdout = stdout_reader
                    .join()
                    .map_err(|_| BackupError::Io(io::Error::other("stdout reader failed")))??;
                let stderr = stderr_reader
                    .join()
                    .map_err(|_| BackupError::Io(io::Error::other("stderr reader failed")))??;
                return Ok(CommandOutput {
                    status,
                    stdout: bounded_output(&stdout),
                    stderr: bounded_output(&stderr),
                });
            }
            thread::sleep(COMMAND_POLL_INTERVAL);
        }
    }
}

fn read_output(mut input: impl Read) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let count = input.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        output.extend_from_slice(&chunk[..count]);
        if output.len() > MAX_COMMAND_OUTPUT {
            output.drain(..output.len() - MAX_COMMAND_OUTPUT);
        }
    }
    Ok(output)
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
    Conflict(String),
    InvalidArchive(String),
    UnsupportedStorage(String),
    InvalidRequest(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => write!(formatter, "Another backup or restore operation is running."),
            Self::Cancelled => write!(formatter, "The operation was cancelled."),
            Self::CommandTimeout => write!(formatter, "The bundled runtime operation timed out."),
            Self::CommandFailed { operation, detail } => {
                write!(formatter, "{operation} failed: {detail}")
            }
            Self::Conflict(name) => write!(formatter, "A VM named {name} already exists."),
            Self::InvalidArchive(detail) => write!(formatter, "Invalid Silo backup: {detail}"),
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
    pub(crate) was_running: bool,
    pub(crate) runtime_config: Value,
    pub(crate) machine_config: Value,
    pub(crate) volumes: Vec<BackupVolumeSource>,
}

#[derive(Clone, Debug)]
pub(crate) struct BackupVolumeSource {
    pub(crate) role: String,
    pub(crate) mount_path: String,
    pub(crate) source_path: PathBuf,
    pub(crate) capacity_bytes: u64,
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
    pub(crate) snapshot_path: PathBuf,
    pub(crate) volumes: Vec<PreparedVolume>,
    _stage: tempfile::TempDir,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedVolume {
    pub(crate) role: String,
    pub(crate) mount_path: String,
    pub(crate) capacity_bytes: u64,
    pub(crate) logical_size_bytes: u64,
    pub(crate) disk_path: PathBuf,
}

/// Atomically installs a verified restored disk into an app-owned destination.
/// The caller owns cleanup of the destination if a later restore step fails.
pub(crate) fn materialize_prepared_volume(
    volume: &PreparedVolume,
    destination: &Path,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    check_cancelled(cancellation)?;
    let parent = destination.parent().ok_or_else(|| {
        BackupError::InvalidRequest("The restored disk destination has no parent directory.".into())
    })?;
    fs::create_dir_all(parent)?;
    if destination.exists() || fs::symlink_metadata(destination).is_ok() {
        return Err(BackupError::Conflict(destination.display().to_string()));
    }
    let temporary = tempfile::Builder::new()
        .prefix(".silo-restored-disk-")
        .tempfile_in(parent)?;
    let temporary_path = temporary.path().to_path_buf();
    temporary.close()?;
    clone_or_sparse_copy(&volume.disk_path, &temporary_path, cancellation)?;
    let installed = fs::symlink_metadata(&temporary_path)?;
    if !installed.is_file() || installed.len() != volume.logical_size_bytes {
        let _ = fs::remove_file(&temporary_path);
        return Err(BackupError::InvalidArchive(
            "The restored disk materialization is incomplete.".into(),
        ));
    }
    check_cancelled(cancellation).inspect_err(|_| {
        let _ = fs::remove_file(&temporary_path);
    })?;
    if let Err(error) = rename_without_replacing(&temporary_path, destination) {
        let _ = fs::remove_file(&temporary_path);
        return Err(if error.kind() == io::ErrorKind::AlreadyExists {
            BackupError::Conflict(destination.display().to_string())
        } else {
            BackupError::Io(error)
        });
    }
    if let Err(error) = File::open(parent).and_then(|directory| directory.sync_all()) {
        let _ = fs::remove_file(destination);
        return Err(BackupError::Io(error));
    }
    Ok(())
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
    volumes: Vec<PackageVolume>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageVolume {
    role: String,
    mount_path: String,
    capacity_bytes: u64,
    logical_size_bytes: u64,
    payload_size: u64,
    payload_sha256: String,
}

struct CapturedVolume {
    manifest: PackageVolume,
    payload_path: PathBuf,
}

struct StagedVolume {
    role: String,
    mount_path: String,
    capacity_bytes: u64,
    logical_size_bytes: u64,
    captured_path: PathBuf,
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

    pub(crate) fn create_backup(
        &self,
        request: BackupRequest,
        cancellation: &Cancellation,
    ) -> Result<BackupResult, BackupError> {
        let _guard = self.begin()?;
        validate_backup_request(&request)?;
        fs::create_dir_all(&self.scratch_root)?;
        let stage = tempfile::Builder::new()
            .prefix("backup-")
            .tempdir_in(&self.scratch_root)?;
        let mut payloads = Vec::with_capacity(request.sources.len());
        let mut total_payload_bytes = 0_u64;
        let mut restart_failures = Vec::new();

        for (index, source) in request.sources.iter().enumerate() {
            check_cancelled(cancellation)?;
            validate_sandbox_name(&source.name)?;
            validate_snapshottable_config(&source.name, &source.runtime_config)?;
            validate_machine_config(&source.name, &source.machine_config)?;
            validate_volume_sources(
                &source.name,
                &source.volumes,
                &source.runtime_config,
                &source.machine_config,
            )?;
            if source.was_running {
                if let Err(error) = self.require_success(
                    "Stopping VM for backup",
                    &["stop".into(), source.name.clone()],
                    cancellation,
                ) {
                    // A cancelled stop command may already have stopped the guest.
                    let restart = self.require_success(
                        "Restoring VM state after interrupted stop",
                        &["start".into(), source.name.clone()],
                        &Cancellation::default(),
                    );
                    return Err(match restart {
                        Ok(_) => error,
                        Err(restart) => BackupError::CommandFailed {
                            operation: "Stopping VM for backup".into(),
                            detail: format!("{error} The VM also could not restart: {restart}"),
                        },
                    });
                }
            }

            let snapshot_name = format!("silo-backup-{index}-{}", unique_suffix());
            let capture_result = (|| {
                self.require_success(
                    "Capturing VM disk",
                    &[
                        "snapshot".into(),
                        "create".into(),
                        snapshot_name.clone(),
                        "--from".into(),
                        source.name.clone(),
                        "--dest-dir".into(),
                        stage.path().to_string_lossy().into_owned(),
                        "--integrity".into(),
                        "--quiet".into(),
                    ],
                    cancellation,
                )?;
                source
                    .volumes
                    .iter()
                    .enumerate()
                    .map(|(volume_index, volume)| {
                        stage_volume(volume, stage.path(), index, volume_index, cancellation)
                    })
                    .collect::<Result<Vec<_>, _>>()
            })();

            if source.was_running {
                let restart = self.restart_vm(&source.name);
                if let Err(error) = restart {
                    restart_failures.push(RestartFailure {
                        sandbox: source.name.clone(),
                        detail: error.to_string(),
                    });
                }
            }
            let staged_volumes = capture_result.map_err(|error| {
                if restart_failures.is_empty() {
                    error
                } else {
                    BackupError::CommandFailed {
                        operation: "Capturing VM disk".into(),
                        detail: format!(
                            "{error} Restart also failed: {}",
                            restart_failures
                                .iter()
                                .map(|failure| format!("{}: {}", failure.sandbox, failure.detail))
                                .collect::<Vec<_>>()
                                .join("; ")
                        ),
                    }
                }
            })?;

            let snapshot_path = stage.path().join(&snapshot_name);
            self.require_success(
                "Verifying captured VM disk",
                &[
                    "snapshot".into(),
                    "verify".into(),
                    snapshot_path.to_string_lossy().into_owned(),
                ],
                cancellation,
            )?;
            let payload_path = stage.path().join(format!("{index}.tar.zst"));
            self.require_success(
                "Writing self-contained VM snapshot",
                &[
                    "snapshot".into(),
                    "save".into(),
                    snapshot_path.to_string_lossy().into_owned(),
                    payload_path.to_string_lossy().into_owned(),
                    "--with-parents".into(),
                    "--with-image".into(),
                ],
                cancellation,
            )?;
            let captured_volumes = staged_volumes
                .into_iter()
                .enumerate()
                .map(|(volume_index, volume)| {
                    finalize_volume(
                        volume,
                        stage.path(),
                        index,
                        volume_index,
                        self.max_archive_bytes,
                        cancellation,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            let (payload_size, payload_sha256) =
                hash_regular_file(&payload_path, self.max_archive_bytes, cancellation)?;
            let volume_payload_bytes = captured_volumes.iter().try_fold(0_u64, |sum, volume| {
                sum.checked_add(volume.manifest.payload_size)
                    .ok_or_else(|| {
                        BackupError::InvalidRequest(
                            "The selected VM disk payloads exceed the backup size safety limit."
                                .into(),
                        )
                    })
            })?;
            total_payload_bytes = total_payload_bytes
                .checked_add(payload_size)
                .and_then(|size| size.checked_add(volume_payload_bytes))
                .filter(|size| *size <= self.max_archive_bytes)
                .ok_or_else(|| {
                    BackupError::InvalidRequest(
                        "The selected VM snapshots exceed the backup size safety limit.".into(),
                    )
                })?;
            payloads.push((
                source,
                payload_path,
                payload_size,
                payload_sha256,
                captured_volumes,
            ));
        }

        let manifest = PackageManifest {
            schema_version: FORMAT_VERSION,
            created_at_ms: now_ms(),
            runtime: RuntimeManifest {
                name: "microsandbox".into(),
                version: "0.6.17".into(),
                snapshot_format: "msb-snapshot-tar-zstd".into(),
                guest_architecture: std::env::consts::ARCH.into(),
            },
            sandboxes: payloads
                .iter()
                .map(
                    |(source, _, payload_size, payload_sha256, volumes)| PackageSandbox {
                        name: source.name.clone(),
                        runtime_config: source.runtime_config.clone(),
                        machine_config: source.machine_config.clone(),
                        payload_size: *payload_size,
                        payload_sha256: payload_sha256.clone(),
                        volumes: volumes
                            .iter()
                            .map(|volume| PackageVolume {
                                role: volume.manifest.role.clone(),
                                mount_path: volume.manifest.mount_path.clone(),
                                capacity_bytes: volume.manifest.capacity_bytes,
                                logical_size_bytes: volume.manifest.logical_size_bytes,
                                payload_size: volume.manifest.payload_size,
                                payload_sha256: volume.manifest.payload_sha256.clone(),
                            })
                            .collect(),
                    },
                )
                .collect(),
        };
        let archive_payloads = payloads
            .iter()
            .flat_map(|(_, snapshot, _, _, volumes)| {
                std::iter::once(snapshot.as_path())
                    .chain(volumes.iter().map(|volume| volume.payload_path.as_path()))
            })
            .collect::<Vec<_>>();
        let size_bytes = write_immutable_package(
            &request.destination,
            &manifest,
            &archive_payloads,
            cancellation,
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
        let snapshots_dir = stage.path().join("snapshots");
        fs::create_dir(&snapshots_dir)?;
        let import_stages_before = cache_import_stages(&self.command.home)?;
        let load_result = self.require_success(
            "Loading VM snapshot",
            &[
                "snapshot".into(),
                "load".into(),
                payload_path.to_string_lossy().into_owned(),
                snapshots_dir.to_string_lossy().into_owned(),
            ],
            cancellation,
        );
        let output = match load_result {
            Ok(output) => output,
            Err(error) => {
                cleanup_new_cache_import_stages(&self.command.home, &import_stages_before);
                return Err(error);
            }
        };
        let snapshot_path = snapshot_path_from_load(&output, &snapshots_dir)?;
        ensure_descendant(&snapshot_path, &snapshots_dir)?;
        self.require_success(
            "Verifying restored VM disk",
            &[
                "snapshot".into(),
                "verify".into(),
                snapshot_path.to_string_lossy().into_owned(),
            ],
            cancellation,
        )?;
        let volume_paths = package.volume_disk_paths[selected_index]
            .as_ref()
            .ok_or_else(|| {
                BackupError::InvalidArchive("volume payloads were not extracted".into())
            })?;
        let volumes = source
            .volumes
            .iter()
            .zip(volume_paths)
            .map(|(volume, path)| PreparedVolume {
                role: volume.role.clone(),
                mount_path: volume.mount_path.clone(),
                capacity_bytes: volume.capacity_bytes,
                logical_size_bytes: volume.logical_size_bytes,
                disk_path: path.clone(),
            })
            .collect();
        Ok(PreparedRestore {
            source_name: source.name.clone(),
            new_name: request.new_name,
            runtime_config: source.runtime_config.clone(),
            machine_config: source.machine_config.clone(),
            snapshot_path,
            volumes,
            _stage: stage,
        })
    }

    fn restart_vm(&self, name: &str) -> Result<(), BackupError> {
        let cancellation = Cancellation::default();
        self.require_success(
            "Restarting VM after disk capture",
            &["start".into(), name.into()],
            &cancellation,
        )?;
        let inspected = self.require_success(
            "Verifying restarted VM",
            &[
                "inspect".into(),
                name.into(),
                "--format".into(),
                "json".into(),
            ],
            &cancellation,
        )?;
        let value: Value = serde_json::from_str(&inspected.stdout)?;
        if value.get("status").and_then(Value::as_str) != Some("Running") {
            return Err(BackupError::CommandFailed {
                operation: "Verifying restarted VM".into(),
                detail: format!("{name} has not reached Running."),
            });
        }
        Ok(())
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
    volume_disk_paths: Vec<Option<Vec<PathBuf>>>,
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
    let payload_total = manifest
        .sandboxes
        .iter()
        .try_fold(0_u64, |sum, sandbox| {
            sandbox.volumes.iter().try_fold(
                sum.checked_add(sandbox.payload_size)?,
                |subtotal, volume| subtotal.checked_add(volume.payload_size),
            )
        })
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
    let mut volume_disk_paths = Vec::with_capacity(manifest.sandboxes.len());
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
        let mut disks = Vec::with_capacity(sandbox.volumes.len());
        for (volume_index, volume) in sandbox.volumes.iter().enumerate() {
            let payload_start = file.stream_position()?;
            let encoded = extract_verified_payload(
                &mut file,
                volume.payload_size,
                &volume.payload_sha256,
                extract_dir.map(|dir| dir.join(format!("volume-{index}-{volume_index}.sparse"))),
                &format!("{} volume payload for {}", volume.role, sandbox.name),
                cancellation,
            )?;
            if let Some(encoded) = encoded {
                let disk = extract_dir
                    .expect("encoded output requires extraction")
                    .join(format!("volume-{index}-{volume_index}.raw"));
                decode_sparse_file(&encoded, &disk, volume.logical_size_bytes, cancellation)?;
                fs::remove_file(encoded)?;
                disks.push(disk);
            } else {
                let payload_end = file.stream_position()?;
                file.seek(SeekFrom::Start(payload_start))?;
                validate_sparse_stream(
                    (&mut file).take(volume.payload_size),
                    volume.logical_size_bytes,
                    cancellation,
                )?;
                file.seek(SeekFrom::Start(payload_end))?;
            }
        }
        volume_disk_paths.push(extract_dir.map(|_| disks));
    }
    Ok(VerifiedPackage {
        manifest,
        snapshot_payload_paths,
        volume_disk_paths,
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
        || manifest.runtime.version != "0.6.17"
        || manifest.runtime.snapshot_format != "msb-snapshot-tar-zstd"
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
        validate_volume_contract(
            &sandbox.volumes,
            &sandbox.runtime_config,
            &sandbox.machine_config,
        )?;
    }
    Ok(())
}

fn validate_package_volumes(volumes: &[PackageVolume]) -> Result<(), BackupError> {
    if volumes.len() != 1 {
        return Err(BackupError::InvalidArchive(
            "each VM must contain its workspace disk alongside its managed root snapshot".into(),
        ));
    }
    let mut roles = HashSet::new();
    let mut mounts = HashSet::new();
    for volume in volumes {
        if volume.role != "workspace"
            || volume.mount_path != "/workspace"
            || !roles.insert(volume.role.as_str())
            || !valid_mount_path(&volume.mount_path)
            || !mounts.insert(volume.mount_path.as_str())
            || volume.capacity_bytes == 0
            || volume.capacity_bytes > DEFAULT_MAX_ARCHIVE_BYTES
            || volume.logical_size_bytes == 0
            || volume.logical_size_bytes != volume.capacity_bytes
            || volume.payload_size == 0
            || !is_sha256(&volume.payload_sha256)
        {
            return Err(BackupError::InvalidArchive(
                "a VM disk manifest is invalid".into(),
            ));
        }
    }
    if !roles.contains("workspace") {
        return Err(BackupError::InvalidArchive(
            "each VM must contain one workspace disk".into(),
        ));
    }
    Ok(())
}

fn validate_volume_sources(
    name: &str,
    volumes: &[BackupVolumeSource],
    runtime_config: &Value,
    machine_config: &Value,
) -> Result<(), BackupError> {
    let configured_mounts = runtime_config
        .get("mounts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            BackupError::UnsupportedStorage(format!("{name} does not report its mounted disks."))
        })?;
    for volume in volumes {
        let matches_config = configured_mounts.iter().any(|mount| {
            mount.get("type").and_then(Value::as_str) == Some("DiskImage")
                && mount.get("guest").and_then(Value::as_str) == Some(volume.mount_path.as_str())
                && mount
                    .get("host")
                    .and_then(Value::as_str)
                    .is_some_and(|host| Path::new(host) == volume.source_path)
        });
        if !matches_config {
            return Err(BackupError::UnsupportedStorage(format!(
                "{name} {} disk does not match its mounted disk image.",
                volume.role
            )));
        }
    }
    let manifests = volumes
        .iter()
        .map(|volume| {
            let metadata = fs::symlink_metadata(&volume.source_path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(BackupError::UnsupportedStorage(format!(
                    "{name} has an invalid {} disk.",
                    volume.role
                )));
            }
            Ok(PackageVolume {
                role: volume.role.clone(),
                mount_path: volume.mount_path.clone(),
                capacity_bytes: volume.capacity_bytes,
                logical_size_bytes: metadata.len(),
                payload_size: 1,
                payload_sha256: format!("sha256:{}", "0".repeat(64)),
            })
        })
        .collect::<Result<Vec<_>, BackupError>>()?;
    validate_package_volumes(&manifests).map_err(|_| {
        BackupError::UnsupportedStorage(format!("{name} must have a Silo-owned workspace disk."))
    })?;
    validate_volume_contract(&manifests, runtime_config, machine_config).map_err(|_| {
        BackupError::UnsupportedStorage(format!(
            "{name} disk metadata does not match its Silo VM configuration."
        ))
    })
}

fn validate_volume_contract(
    volumes: &[PackageVolume],
    runtime_config: &Value,
    machine_config: &Value,
) -> Result<(), BackupError> {
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
    let gib = 1024_u64 * 1024 * 1024;
    let expected = |role: &str, field: &str| {
        let capacity = machine_config
            .get(field)
            .and_then(Value::as_u64)
            .and_then(|value| value.checked_mul(gib));
        volumes
            .iter()
            .find(|volume| volume.role == role)
            .is_some_and(|volume| Some(volume.capacity_bytes) == capacity)
    };
    if !expected("workspace", "workspaceStorageGiB")
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
    let mount_paths = runtime_config
        .get("mounts")
        .and_then(Value::as_array)
        .ok_or_else(|| BackupError::InvalidArchive("VM mounts are missing".into()))?
        .iter()
        .filter(|mount| mount.get("type").and_then(Value::as_str) == Some("DiskImage"))
        .filter_map(|mount| mount.get("guest").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if mount_paths.len() != 1
        || volumes
            .iter()
            .any(|volume| !mount_paths.contains(volume.mount_path.as_str()))
    {
        return Err(BackupError::InvalidArchive(
            "VM disk mounts do not match the machine settings".into(),
        ));
    }
    Ok(())
}

fn valid_mount_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && !path.contains('\0')
        && Path::new(path).components().all(|component| {
            matches!(
                component,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
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
        return Err(BackupError::Conflict(
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
    if object.len() != FIELDS.len()
        || object.keys().any(|key| !FIELDS.contains(&key.as_str()))
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

fn validate_snapshottable_config(name: &str, config: &Value) -> Result<(), BackupError> {
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
            "{name} does not use the managed OCI root disk required by MicroSandbox 0.6.17 snapshots."
        ))),
    }
}

// Silo currently creates Ubuntu VMs with these runtime defaults. Reject overrides
// that the restore command does not reproduce instead of silently changing them.
// Only the exact credential-free profile installed during Silo VM creation is
// restorable here. Custom policies, host secret references and values stay blocked.
pub(crate) fn default_github_network(network: &Value) -> bool {
    let expected: Value = serde_json::from_str(include_str!("../guest/github-network-default.json"))
        .expect("checked-in GitHub network defaults");
    network == &expected
}

fn supported_runtime_settings(config: &serde_json::Map<String, Value>) -> bool {
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
            if field == "network" && default_github_network(value) {
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
        .filter(|mount| mount.get("type").and_then(Value::as_str) == Some("DiskImage"))
        .collect::<Vec<_>>();
    if disks.len() != 1 || !disks.iter().all(|mount| valid_disk_image_mount(mount)) {
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

fn valid_disk_image_mount(mount: &Value) -> bool {
    let Some(mount) = mount.as_object() else {
        return false;
    };
    const FIELDS: &[&str] = &["type", "host", "guest", "format", "fstype", "options"];
    if mount.keys().any(|key| !FIELDS.contains(&key.as_str()))
        || mount.get("type").and_then(Value::as_str) != Some("DiskImage")
        || !mount
            .get("host")
            .and_then(Value::as_str)
            .is_some_and(|path| Path::new(path).is_absolute())
        || !mount
            .get("guest")
            .and_then(Value::as_str)
            .is_some_and(valid_mount_path)
        || mount.get("format").and_then(Value::as_str) != Some("Raw")
        || !mount
            .get("fstype")
            .is_some_and(|value| value.is_null() || value.as_str() == Some("ext4"))
    {
        return false;
    }
    let Some(options) = mount.get("options").and_then(Value::as_object) else {
        return false;
    };
    const OPTION_FIELDS: &[&str] = &[
        "readonly",
        "noexec",
        "nosuid",
        "nodev",
        "override_uid",
        "override_gid",
    ];
    !options
        .keys()
        .any(|key| !OPTION_FIELDS.contains(&key.as_str()))
        && options.get("readonly").and_then(Value::as_bool) == Some(false)
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

fn stage_volume(
    source: &BackupVolumeSource,
    stage: &Path,
    sandbox_index: usize,
    volume_index: usize,
    cancellation: &Cancellation,
) -> Result<StagedVolume, BackupError> {
    check_cancelled(cancellation)?;
    let metadata = fs::symlink_metadata(&source.source_path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > source.capacity_bytes
    {
        return Err(BackupError::UnsupportedStorage(format!(
            "The {} disk is not a valid Silo-owned disk image.",
            source.role
        )));
    }
    let captured = stage.join(format!("volume-{sandbox_index}-{volume_index}.raw.capture"));
    clone_or_sparse_copy(&source.source_path, &captured, cancellation)?;
    let captured_metadata = fs::symlink_metadata(&captured)?;
    if !captured_metadata.is_file() || captured_metadata.len() != metadata.len() {
        return Err(BackupError::InvalidArchive(format!(
            "The {} disk capture is incomplete.",
            source.role
        )));
    }
    Ok(StagedVolume {
        role: source.role.clone(),
        mount_path: source.mount_path.clone(),
        capacity_bytes: source.capacity_bytes,
        logical_size_bytes: metadata.len(),
        captured_path: captured,
    })
}

fn finalize_volume(
    staged: StagedVolume,
    stage: &Path,
    sandbox_index: usize,
    volume_index: usize,
    max_bytes: u64,
    cancellation: &Cancellation,
) -> Result<CapturedVolume, BackupError> {
    let payload_path = stage.join(format!("volume-{sandbox_index}-{volume_index}.sparse"));
    encode_sparse_file(&staged.captured_path, &payload_path, cancellation)?;
    fs::remove_file(staged.captured_path)?;
    let (payload_size, payload_sha256) = hash_regular_file(&payload_path, max_bytes, cancellation)?;
    Ok(CapturedVolume {
        manifest: PackageVolume {
            role: staged.role,
            mount_path: staged.mount_path,
            capacity_bytes: staged.capacity_bytes,
            logical_size_bytes: staged.logical_size_bytes,
            payload_size,
            payload_sha256,
        },
        payload_path,
    })
}

fn clone_or_sparse_copy(
    source: &Path,
    destination: &Path,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    match try_clone_file(source, destination) {
        Ok(true) => {
            File::open(destination)?.sync_all()?;
            return Ok(());
        }
        Ok(false) => {}
        Err(error) => {
            let _ = fs::remove_file(destination);
            return Err(BackupError::Io(error));
        }
    }
    let _ = fs::remove_file(destination);
    let mut input = File::open(source)?;
    let logical_size = input.metadata()?.len();
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    output.set_len(logical_size)?;
    copy_sparse_contents(&mut input, &mut output, logical_size, cancellation)?;
    output.sync_all()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn try_clone_file(source: &Path, destination: &Path) -> io::Result<bool> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn clonefile(
            source: *const libc::c_char,
            destination: *const libc::c_char,
            flags: u32,
        ) -> libc::c_int;
    }
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // SAFETY: both pointers reference live NUL-terminated path strings for this call.
    let result = unsafe { clonefile(source.as_ptr(), destination.as_ptr(), 0) };
    if result == 0 {
        Ok(true)
    } else {
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ENOTSUP | libc::EXDEV | libc::EINVAL) => Ok(false),
            _ => Err(error),
        }
    }
}

#[cfg(target_os = "linux")]
fn try_clone_file(source: &Path, destination: &Path) -> io::Result<bool> {
    const FICLONE: libc::c_ulong = 0x4004_9409;
    let input = File::open(source)?;
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    // SAFETY: ioctl only reads the valid source fd and writes clone metadata to output fd.
    let result = unsafe { libc::ioctl(output.as_raw_fd(), FICLONE, input.as_raw_fd()) };
    if result == 0 {
        Ok(true)
    } else {
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EOPNOTSUPP | libc::EXDEV | libc::EINVAL | libc::ENOTTY) => Ok(false),
            _ => Err(error),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn try_clone_file(_source: &Path, _destination: &Path) -> io::Result<bool> {
    Ok(false)
}

fn copy_sparse_contents(
    input: &mut File,
    output: &mut File,
    logical_size: u64,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    match sparse_extents(input, logical_size)? {
        Some(extents) => {
            for (offset, length) in extents {
                copy_extent(input, output, offset, length, cancellation)?;
            }
        }
        None => copy_nonzero_blocks(input, output, logical_size, cancellation)?,
    }
    Ok(())
}

fn sparse_extents(input: &File, logical_size: u64) -> io::Result<Option<Vec<(u64, u64)>>> {
    if logical_size > i64::MAX as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "disk image is too large",
        ));
    }
    let mut extents = Vec::new();
    let mut cursor = 0_u64;
    while cursor < logical_size {
        // SAFETY: input fd is valid and offsets were bounded above.
        let data =
            unsafe { libc::lseek(input.as_raw_fd(), cursor as libc::off_t, libc::SEEK_DATA) };
        if data < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENXIO) {
                break;
            }
            if error.raw_os_error() == Some(libc::EINVAL) {
                return Ok(None);
            }
            return Err(error);
        }
        // SAFETY: input fd is valid and data was returned by lseek.
        let hole = unsafe { libc::lseek(input.as_raw_fd(), data, libc::SEEK_HOLE) };
        if hole < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINVAL) {
                return Ok(None);
            }
            return Err(error);
        }
        let start = data as u64;
        let end = (hole as u64).min(logical_size);
        if end <= start {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid sparse extent",
            ));
        }
        extents.push((start, end - start));
        cursor = end;
    }
    Ok(Some(extents))
}

fn copy_extent(
    input: &mut File,
    output: &mut File,
    offset: u64,
    length: u64,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    input.seek(SeekFrom::Start(offset))?;
    output.seek(SeekFrom::Start(offset))?;
    let mut remaining = length;
    let mut buffer = [0_u8; 128 * 1024];
    while remaining > 0 {
        check_cancelled(cancellation)?;
        let wanted = remaining.min(buffer.len() as u64) as usize;
        input.read_exact(&mut buffer[..wanted])?;
        output.write_all(&buffer[..wanted])?;
        remaining -= wanted as u64;
    }
    Ok(())
}

fn copy_nonzero_blocks(
    input: &mut File,
    output: &mut File,
    logical_size: u64,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    input.seek(SeekFrom::Start(0))?;
    let mut offset = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    while offset < logical_size {
        check_cancelled(cancellation)?;
        let wanted = (logical_size - offset).min(buffer.len() as u64) as usize;
        input.read_exact(&mut buffer[..wanted])?;
        if buffer[..wanted].iter().any(|byte| *byte != 0) {
            output.seek(SeekFrom::Start(offset))?;
            output.write_all(&buffer[..wanted])?;
        }
        offset += wanted as u64;
    }
    Ok(())
}

fn encode_sparse_file(
    source: &Path,
    destination: &Path,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    let mut input = File::open(source)?;
    let logical_size = input.metadata()?.len();
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    output.write_all(SPARSE_MAGIC)?;
    output.write_all(&SPARSE_VERSION.to_be_bytes())?;
    output.write_all(&logical_size.to_be_bytes())?;
    match sparse_extents(&input, logical_size)? {
        Some(extents) => {
            for (offset, length) in extents {
                output.write_all(&offset.to_be_bytes())?;
                output.write_all(&length.to_be_bytes())?;
                input.seek(SeekFrom::Start(offset))?;
                copy_exact_bytes(&mut input, &mut output, length, cancellation)?;
            }
        }
        None => {
            input.seek(SeekFrom::Start(0))?;
            let mut offset = 0_u64;
            let mut buffer = [0_u8; 128 * 1024];
            while offset < logical_size {
                check_cancelled(cancellation)?;
                let wanted = (logical_size - offset).min(buffer.len() as u64) as usize;
                input.read_exact(&mut buffer[..wanted])?;
                if buffer[..wanted].iter().any(|byte| *byte != 0) {
                    output.write_all(&offset.to_be_bytes())?;
                    output.write_all(&(wanted as u64).to_be_bytes())?;
                    output.write_all(&buffer[..wanted])?;
                }
                offset += wanted as u64;
            }
        }
    }
    output.write_all(&u64::MAX.to_be_bytes())?;
    output.write_all(&0_u64.to_be_bytes())?;
    output.sync_all()?;
    Ok(())
}

fn copy_exact_bytes(
    input: &mut File,
    output: &mut File,
    mut remaining: u64,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    let mut buffer = [0_u8; 128 * 1024];
    while remaining > 0 {
        check_cancelled(cancellation)?;
        let wanted = remaining.min(buffer.len() as u64) as usize;
        input.read_exact(&mut buffer[..wanted])?;
        output.write_all(&buffer[..wanted])?;
        remaining -= wanted as u64;
    }
    Ok(())
}

fn decode_sparse_file(
    source: &Path,
    destination: &Path,
    expected_logical_size: u64,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    let mut input = File::open(source)?;
    let mut magic = [0_u8; SPARSE_MAGIC.len()];
    input.read_exact(&mut magic).map_err(|_| {
        BackupError::InvalidArchive("a VM disk payload header is incomplete".into())
    })?;
    if &magic != SPARSE_MAGIC || read_u32(&mut input)? != SPARSE_VERSION {
        return Err(BackupError::InvalidArchive(
            "a VM disk payload format is unsupported".into(),
        ));
    }
    let logical_size = read_u64(&mut input)?;
    if logical_size != expected_logical_size {
        return Err(BackupError::InvalidArchive(
            "a VM disk logical size does not match its manifest".into(),
        ));
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    output.set_len(logical_size)?;
    let mut previous_end = 0_u64;
    loop {
        check_cancelled(cancellation)?;
        let offset = read_u64(&mut input)?;
        let length = read_u64(&mut input)?;
        if offset == u64::MAX && length == 0 {
            break;
        }
        let end = offset
            .checked_add(length)
            .ok_or_else(|| BackupError::InvalidArchive("a VM disk extent overflows".into()))?;
        if length == 0 || offset < previous_end || end > logical_size {
            return Err(BackupError::InvalidArchive(
                "a VM disk extent is invalid".into(),
            ));
        }
        output.seek(SeekFrom::Start(offset))?;
        let mut remaining = length;
        let mut buffer = [0_u8; 128 * 1024];
        while remaining > 0 {
            check_cancelled(cancellation)?;
            let wanted = remaining.min(buffer.len() as u64) as usize;
            input.read_exact(&mut buffer[..wanted]).map_err(|_| {
                BackupError::InvalidArchive("a VM disk extent is incomplete".into())
            })?;
            output.write_all(&buffer[..wanted])?;
            remaining -= wanted as u64;
        }
        previous_end = end;
    }
    if input.stream_position()? != input.metadata()?.len() {
        return Err(BackupError::InvalidArchive(
            "a VM disk payload has trailing data".into(),
        ));
    }
    output.sync_all()?;
    Ok(())
}

fn validate_sparse_stream(
    mut input: impl Read,
    expected_logical_size: u64,
    cancellation: &Cancellation,
) -> Result<(), BackupError> {
    let mut magic = [0_u8; SPARSE_MAGIC.len()];
    input.read_exact(&mut magic).map_err(|_| {
        BackupError::InvalidArchive("a VM disk payload header is incomplete".into())
    })?;
    if &magic != SPARSE_MAGIC || read_u32(&mut input)? != SPARSE_VERSION {
        return Err(BackupError::InvalidArchive(
            "a VM disk payload format is unsupported".into(),
        ));
    }
    let logical_size = read_u64(&mut input)?;
    if logical_size != expected_logical_size {
        return Err(BackupError::InvalidArchive(
            "a VM disk logical size does not match its manifest".into(),
        ));
    }
    let mut previous_end = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        check_cancelled(cancellation)?;
        let offset = read_u64(&mut input)?;
        let length = read_u64(&mut input)?;
        if offset == u64::MAX && length == 0 {
            break;
        }
        let end = offset
            .checked_add(length)
            .filter(|end| length > 0 && offset >= previous_end && *end <= logical_size)
            .ok_or_else(|| BackupError::InvalidArchive("a VM disk extent is invalid".into()))?;
        let mut remaining = length;
        while remaining > 0 {
            check_cancelled(cancellation)?;
            let wanted = remaining.min(buffer.len() as u64) as usize;
            input.read_exact(&mut buffer[..wanted]).map_err(|_| {
                BackupError::InvalidArchive("a VM disk extent is incomplete".into())
            })?;
            remaining -= wanted as u64;
        }
        previous_end = end;
    }
    let mut trailing = [0_u8; 1];
    if input.read(&mut trailing)? != 0 {
        return Err(BackupError::InvalidArchive(
            "a VM disk payload has trailing data".into(),
        ));
    }
    Ok(())
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
    let mut temporary = tempfile::Builder::new()
        .prefix(".silo-backup-")
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
            BackupError::Conflict(destination.display().to_string())
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

fn snapshot_path_from_load(
    output: &CommandOutput,
    snapshots_dir: &Path,
) -> Result<PathBuf, BackupError> {
    let stdout_path = output.stdout.lines().rev().find_map(|line| {
        let path = PathBuf::from(line.trim());
        path.is_absolute().then_some(path)
    });
    if let Some(path) = stdout_path {
        return Ok(path);
    }
    let entries = fs::read_dir(snapshots_dir)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    match entries.as_slice() {
        [path] => Ok(path.clone()),
        _ => Err(BackupError::CommandFailed {
            operation: "Loading VM snapshot".into(),
            detail: "the bundled runtime did not identify one restored snapshot".into(),
        }),
    }
}

fn ensure_descendant(path: &Path, root: &Path) -> Result<(), BackupError> {
    let root = fs::canonicalize(root)?;
    let path = fs::canonicalize(path)?;
    if !path.starts_with(&root) || path == root {
        return Err(BackupError::InvalidArchive(
            "the restored snapshot escaped its private staging directory".into(),
        ));
    }
    Ok(())
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
        fail_start: AtomicBool,
        fail_running_verification: AtomicBool,
        fail_load: AtomicBool,
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
                ["snapshot", "create", name, "--from", _, "--dest-dir", dest, "--integrity", "--quiet"] =>
                {
                    let snapshot = Path::new(dest).join(name);
                    fs::create_dir(&snapshot)?;
                    fs::write(snapshot.join("snapshot.json"), b"{}")?;
                    fs::write(snapshot.join("upper.ext4"), b"disk")?;
                    if self.cancel_after_snapshot.load(Ordering::Acquire) {
                        cancellation.cancel();
                    }
                    Ok(success())
                }
                ["inspect", _, "--format", "json"] => Ok(CommandOutput {
                    status: ExitStatus::from_raw(0),
                    stdout: serde_json::json!({"status": if self.fail_running_verification.load(Ordering::Acquire) {"Stopped"} else {"Running"}}).to_string(),
                    stderr: String::new(),
                }),
                ["snapshot", "save", _, output, "--with-parents", "--with-image"] => {
                    fs::write(output, b"\x28\xb5\x2f\xfdself-contained snapshot")?;
                    Ok(success())
                }
                ["snapshot", "load", _, dest] => {
                    let snapshot = Path::new(dest).join("loaded-snapshot");
                    fs::create_dir(&snapshot)?;
                    fs::write(snapshot.join("snapshot.json"), b"{}")?;
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
                        stdout: format!("sha256:fake\n{}\n", snapshot.display()),
                        ..success()
                    })
                }
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
            "image": {"Oci": {"reference": "alpine:3.20", "root_disk": {"kind": "managed", "size_mib": 81920}}},
            "mounts": [
                {
                    "type": "DiskImage",
                    "host": "/app-owned/dev-workspace.raw",
                    "guest": "/workspace",
                    "format": "Raw",
                    "fstype": "ext4",
                    "options": {"readonly": false, "noexec": false, "nosuid": false, "nodev": false, "override_uid": null, "override_gid": null}
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
        let volumes_root = service.scratch_root.parent().unwrap().join("owned-volumes");
        fs::create_dir_all(&volumes_root).unwrap();
        let workspace = volumes_root.join("dev-workspace.raw");
        if !workspace.exists() {
            let file = File::create(&workspace).unwrap();
            file.set_len(60 * 1024 * 1024 * 1024).unwrap();
            use std::os::unix::fs::FileExt;
            file.write_all_at(b"workspace-data", 64 * 1024).unwrap();
        }
        let mut runtime_config = managed_config("dev");
        runtime_config["mounts"][0]["host"] =
            Value::String(workspace.to_string_lossy().into_owned());
        service.create_backup(
            BackupRequest {
                destination,
                sources: vec![BackupSource {
                    name: "dev".into(),
                    was_running: running,
                    runtime_config,
                    machine_config: machine_config("dev"),
                    volumes: vec![BackupVolumeSource {
                        role: "workspace".into(),
                        mount_path: "/workspace".into(),
                        source_path: workspace,
                        capacity_bytes: 60 * 1024 * 1024 * 1024,
                    }],
                }],
            },
            &Cancellation::default(),
        )
    }

    #[test]
    fn backup_contract_requires_real_root_capacity_and_one_workspace_disk() {
        let config = managed_config("dev");
        let machine = machine_config("dev");
        let volume = PackageVolume {
            role: "workspace".into(),
            mount_path: "/workspace".into(),
            capacity_bytes: 60 * 1024 * 1024 * 1024,
            logical_size_bytes: 60 * 1024 * 1024 * 1024,
            payload_size: 1,
            payload_sha256: format!("sha256:{}", "0".repeat(64)),
        };
        assert!(validate_volume_contract(std::slice::from_ref(&volume), &config, &machine).is_ok());
        let mut wrong_root = config.clone();
        wrong_root["image"]["Oci"]["root_disk"]["size_mib"] = Value::from(8192);
        assert!(
            validate_volume_contract(std::slice::from_ref(&volume), &wrong_root, &machine).is_err()
        );
        let mut extra_disk = config;
        extra_disk["mounts"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"type":"DiskImage", "guest":"/extra"}));
        assert!(validate_snapshottable_config("dev", &extra_disk).is_err());
        assert!(validate_package_volumes(&[]).is_err());
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
        assert!(matches!(
            create_one(&service, destination.clone(), false),
            Err(BackupError::Conflict(_))
        ));
        assert_eq!(fs::read(destination).unwrap(), first);
        let calls = service.runner.calls.lock().unwrap();
        assert!(calls
            .iter()
            .any(|args| args.ends_with(&["--with-parents".into(), "--with-image".into()])));
    }

    #[test]
    fn running_vm_restarts_after_capture_and_restart_failure_is_separate() {
        let temp = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        runner.fail_start.store(true, Ordering::Release);
        let service = service(&temp, runner);
        let result = create_one(&service, temp.path().join("dev.silo-backup"), true).unwrap();
        assert_eq!(result.restart_failures.len(), 1);
        assert!(result.destination.is_file());
        let calls = service.runner.calls.lock().unwrap();
        let stop = calls
            .iter()
            .position(|args| args.first().is_some_and(|arg| arg == "stop"))
            .unwrap();
        let capture = calls
            .iter()
            .position(|args| args.get(1).is_some_and(|arg| arg == "create"))
            .unwrap();
        let restart = calls
            .iter()
            .position(|args| args.first().is_some_and(|arg| arg == "start"))
            .unwrap();
        let archive = calls
            .iter()
            .position(|args| args.get(1).is_some_and(|arg| arg == "save"))
            .unwrap();
        assert!(stop < capture && capture < restart && restart < archive);
    }

    #[test]
    fn default_github_network_is_restorable_but_credentials_and_policy_changes_are_not() {
        let mut config = managed_config("dev");
        config["network"] = serde_json::from_str(include_str!("../guest/github-network-default.json")).unwrap();
        assert!(validate_snapshottable_config("dev", &config).is_ok());
        let original = config.clone();
        config["network"]["secrets"]["secrets"][0]["value"] = serde_json::json!("must-not-be-archived");
        assert!(validate_snapshottable_config("dev", &config).is_err());
        config = original.clone();
        config["network"]["tls"]["verify_upstream"] = serde_json::json!(false);
        assert!(validate_snapshottable_config("dev", &config).is_err());
        config = original;
        config["network"]["secrets"]["secrets"][0]["source"] = serde_json::json!({"kind":"file","path":"/private/secret"});
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
    fn successful_start_command_without_running_state_keeps_restart_failure() {
        let temp = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        runner
            .fail_running_verification
            .store(true, Ordering::Release);
        let result = create_one(
            &service(&temp, runner),
            temp.path().join("backup.silo-backup"),
            true,
        )
        .unwrap();
        assert_eq!(result.restart_failures.len(), 1);
        assert!(result.restart_failures[0]
            .detail
            .contains("not reached Running"));
        assert!(result.destination.is_file());
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
                        was_running: false,
                        runtime_config: managed_config("dev"),
                        machine_config: machine_config("dev"),
                        volumes: Vec::new(),
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
    fn cancellation_during_stopped_capture_restarts_the_vm() {
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
        let calls = service.runner.calls.lock().unwrap();
        assert!(calls
            .iter()
            .any(|arguments| arguments.as_slice() == ["stop", "dev"]));
        assert!(calls
            .iter()
            .any(|arguments| arguments.as_slice() == ["start", "dev"]));
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
    fn restore_rejects_conflict_and_returns_verified_private_stage() {
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
        fs::remove_dir_all(temp.path().join("owned-volumes")).unwrap();
        assert_eq!(restored.source_name, "dev");
        assert_eq!(restored.new_name, "dev-restored");
        assert_eq!(restored.runtime_config["name"], "dev");
        assert_eq!(restored.machine_config["workspaceStorageGiB"], 60);
        assert_eq!(restored.machine_config["runtimeStorageGiB"], 80);
        assert!(restored.snapshot_path.join("snapshot.json").is_file());
        assert_eq!(restored.volumes.len(), 1);
        let workspace = restored
            .volumes
            .iter()
            .find(|volume| volume.role == "workspace")
            .unwrap();
        assert_eq!(workspace.mount_path, "/workspace");
        assert_eq!(workspace.capacity_bytes, 60 * 1024 * 1024 * 1024);
        assert_eq!(workspace.logical_size_bytes, 60 * 1024 * 1024 * 1024);
        use std::os::unix::fs::FileExt;
        let mut bytes = [0_u8; 14];
        File::open(&workspace.disk_path)
            .unwrap()
            .read_exact_at(&mut bytes, 64 * 1024)
            .unwrap();
        assert_eq!(&bytes, b"workspace-data");
        let stage_root = restored
            .snapshot_path
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        drop(restored);
        assert!(!stage_root.exists());
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
        assert!(!temp
            .path()
            .join("home/cache/tmp/snapshot-import-interrupted")
            .exists());
    }

    #[test]
    fn manifest_does_not_allow_path_like_sandbox_names() {
        assert!(validate_sandbox_name("../victim").is_err());
        assert!(validate_sandbox_name("/absolute").is_err());
        assert!(validate_sandbox_name("valid-name").is_ok());
    }

    #[test]
    fn malformed_sparse_extents_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let payload = temp.path().join("unsafe.sparse");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(SPARSE_MAGIC);
        bytes.extend_from_slice(&SPARSE_VERSION.to_be_bytes());
        bytes.extend_from_slice(&4096_u64.to_be_bytes());
        bytes.extend_from_slice(&2048_u64.to_be_bytes());
        bytes.extend_from_slice(&4_u64.to_be_bytes());
        bytes.extend_from_slice(b"safe");
        bytes.extend_from_slice(&1024_u64.to_be_bytes());
        bytes.extend_from_slice(&4_u64.to_be_bytes());
        bytes.extend_from_slice(b"evil");
        bytes.extend_from_slice(&u64::MAX.to_be_bytes());
        bytes.extend_from_slice(&0_u64.to_be_bytes());
        fs::write(&payload, bytes).unwrap();
        let destination = temp.path().join("disk.raw");
        assert!(matches!(
            decode_sparse_file(&payload, &destination, 4096, &Cancellation::default()),
            Err(BackupError::InvalidArchive(_))
        ));
    }

    #[test]
    fn prepared_disk_materialization_is_atomic_and_never_replaces_a_target() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.raw");
        let file = File::create(&source).unwrap();
        file.set_len(1024 * 1024).unwrap();
        use std::os::unix::fs::FileExt;
        file.write_all_at(b"restored", 4096).unwrap();
        let volume = PreparedVolume {
            role: "workspace".into(),
            mount_path: "/workspace".into(),
            capacity_bytes: 1024 * 1024,
            logical_size_bytes: 1024 * 1024,
            disk_path: source,
        };
        let target = temp.path().join("target.raw");
        fs::write(&target, b"original").unwrap();
        let cancellation = Cancellation::default();
        cancellation.cancel();
        assert!(matches!(
            materialize_prepared_volume(&volume, &target, &cancellation),
            Err(BackupError::Cancelled)
        ));
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(matches!(
            materialize_prepared_volume(&volume, &target, &Cancellation::default()),
            Err(BackupError::Conflict(_))
        ));
        assert_eq!(fs::read(&target).unwrap(), b"original");
        fs::remove_file(&target).unwrap();
        materialize_prepared_volume(&volume, &target, &Cancellation::default()).unwrap();
        assert_eq!(fs::metadata(&target).unwrap().len(), 1024 * 1024);
        let mut bytes = [0_u8; 8];
        File::open(&target)
            .unwrap()
            .read_exact_at(&mut bytes, 4096)
            .unwrap();
        assert_eq!(&bytes, b"restored");
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".silo-restored-disk-")
        }));
    }
}
