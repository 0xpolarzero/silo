use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::VecDeque;
use std::{
    collections::{HashMap, HashSet},
    ffi::CString,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MUTATION_TIMEOUT: Duration = Duration::from_secs(180);
const STOP_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
pub(crate) const WORKSPACE_MOUNT: &str = "/workspace";
const MAX_MACHINE_COUNT: usize = 64;
const MANAGED_LABEL: &str = "silo.managed=true";
const DEFAULT_IMAGE: &str = "registry-1.docker.io/library/ubuntu:24.04";

pub(crate) static MUTATION_LOCK: Mutex<()> = Mutex::new(());
const DISABLED_GITHUB_PROFILE: &str = r#"{"version":1,"owners":[]}"#;
static GITHUB_PROFILES: OnceLock<Mutex<HashMap<(PathBuf, String), String>>> = OnceLock::new();
type GithubRevisionLocks = HashMap<(PathBuf, String), Arc<Mutex<u64>>>;
static GITHUB_REVISION_LOCKS: OnceLock<Mutex<GithubRevisionLocks>> = OnceLock::new();

fn github_revision_lock(home: &Path, workspace: &str) -> Result<Arc<Mutex<u64>>, String> {
    Ok(GITHUB_REVISION_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "GitHub runtime state is unavailable.")?
        .entry((home.to_owned(), workspace.into()))
        .or_insert_with(|| Arc::new(Mutex::new(0)))
        .clone())
}

fn accept_github_revision(current: &mut u64, revision: u64) -> Result<(), String> {
    if revision < *current {
        return Err("A newer GitHub access choice has replaced this update.".into());
    }
    *current = revision;
    Ok(())
}

fn github_command_workspace(args: &[String]) -> Option<&str> {
    match args.first().map(String::as_str) {
        Some("start" | "modify" | "restart") => args
            .get(1)
            .map(String::as_str)
            .filter(|name| validate_name(name).is_ok()),
        _ => None,
    }
}

pub(crate) fn github_environment(paths: &RuntimePaths, args: &[String]) -> String {
    let Some(workspace) = github_command_workspace(args) else {
        return DISABLED_GITHUB_PROFILE.into();
    };
    let cache = GITHUB_PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(profiles) = cache.lock() else {
        return DISABLED_GITHUB_PROFILE.into();
    };
    profiles
        .get(&(paths.home.clone(), workspace.into()))
        .cloned()
        .unwrap_or_else(|| DISABLED_GITHUB_PROFILE.into())
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimePaths {
    pub(crate) executable: PathBuf,
    pub(crate) home: PathBuf,
    pub(crate) storage_home: Option<PathBuf>,
    pub(crate) library: PathBuf,
    pub(crate) metadata: PathBuf,
    pub(crate) volumes: PathBuf,
}

#[derive(Debug)]
pub(crate) struct CommandOutput {
    pub(crate) stdout: String,
    #[allow(dead_code)]
    pub(crate) stderr: String,
}

#[derive(Debug)]
pub(crate) enum RuntimeError {
    Busy,
    Invalid(String),
    Unavailable(String),
    TimedOut { operation: String },
    Failed { operation: String, detail: String },
    Malformed(String),
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => formatter.write_str("Another sandbox operation is still running."),
            Self::Invalid(message) | Self::Unavailable(message) | Self::Malformed(message) => {
                formatter.write_str(message)
            }
            Self::TimedOut { operation } => {
                write!(
                    formatter,
                    "{operation} timed out. Check the sandbox state, then retry."
                )
            }
            Self::Failed { operation, detail } => write!(formatter, "{operation} failed: {detail}"),
        }
    }
}

pub(crate) trait RuntimeRunner {
    fn run(
        &self,
        paths: &RuntimePaths,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, RuntimeError>;
}

struct ProcessRunner;

impl RuntimeRunner for ProcessRunner {
    fn run(
        &self,
        paths: &RuntimePaths,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, RuntimeError> {
        run_msb(paths, args, timeout)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineConfigurationRequest {
    pub(crate) schema_version: u8,
    pub(crate) machines: Vec<MachineConfiguration>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum MachineConfiguration {
    Vm {
        id: String,
        name: String,
        cpus: u8,
        #[serde(rename = "maxCPUs")]
        max_cpus: u8,
        #[serde(rename = "memoryGiB")]
        memory_gib: u32,
        #[serde(rename = "maxMemoryGiB")]
        max_memory_gib: u32,
        #[serde(rename = "workspaceStorageGiB")]
        workspace_storage_gib: u32,
        #[serde(rename = "runtimeStorageGiB")]
        runtime_storage_gib: u32,
    },
    Ssh {
        id: String,
        name: String,
        host: String,
        user: String,
        port: u16,
    },
}

impl MachineConfiguration {
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Vm { id, .. } | Self::Ssh { id, .. } => id,
        }
    }

    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Vm { name, .. } | Self::Ssh { name, .. } => name,
        }
    }

    pub(crate) fn is_vm(&self) -> bool {
        matches!(self, Self::Vm { .. })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSource {
    runtime_repair: Option<Value>,
    workspaces: Vec<ApplicationWorkspace>,
    activities: Vec<Value>,
    sandbox_configuration_operation: Option<Value>,
    repository_push_operations: Vec<Value>,
    github: Value,
    secrets: Vec<Value>,
    backup: BackupSummary,
    preferences: Preferences,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationWorkspace {
    machine: MachineConfiguration,
    purpose: String,
    state: WorkspaceState,
    state_detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    attention: Option<WorkspaceAttention>,
    freshness: Freshness,
    host: String,
    repositories: Vec<Value>,
    files: Vec<Value>,
    ports: Vec<Value>,
    logs: Vec<Value>,
    github_repositories: Vec<String>,
    secret_names: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkspaceState {
    Running,
    Starting,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
struct WorkspaceAttention {
    level: AttentionLevel,
    message: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum AttentionLevel {
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Freshness {
    Fresh,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupSummary {
    last_archive: String,
    completed_label: String,
    compressed_size: String,
    destination: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    terminal: &'static str,
    editor: &'static str,
    browser: &'static str,
    terminal_path: Option<String>,
    editor_path: Option<String>,
    browser_path: Option<String>,
    terminal_use_system_default: bool,
    editor_use_system_default: bool,
    browser_use_system_default: bool,
    launch_at_login: bool,
    start_workspaces_at_launch: bool,
    startup_workspace_ids: Vec<String>,
    reduce_motion: bool,
}

#[derive(Debug, Deserialize)]
struct ListedSandbox {
    name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InspectedSandbox {
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) config: Value,
}

#[derive(Clone, Copy, Debug)]
struct HostResources {
    logical_cpus: usize,
    physical_memory_bytes: Option<u64>,
}

pub(crate) fn runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Silo could not locate its bundled runtime: {error}"))?
        .parent()
        .ok_or_else(|| "Silo could not locate its bundled runtime directory.".to_string())?
        .join(if cfg!(windows) { "msb.exe" } else { "msb" });
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Silo could not locate its application storage: {error}"))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Silo could not locate its bundled resources: {error}"))?;
    let library = bundled_runtime_library(&executable, &resource_dir);
    let storage = app_data.join("runtime");
    let storage_home = storage.join("microsandbox");
    let user_home = app.path().home_dir().map_err(|error| error.to_string())?;
    let home = runtime_home_alias(&user_home, &storage_home);
    Ok(RuntimePaths {
        executable,
        home,
        storage_home: Some(storage_home),
        library,
        metadata: storage.join("machines.json"),
        volumes: storage.join("volumes"),
    })
}

fn bundled_runtime_library(executable: &Path, resource_dir: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let _ = resource_dir;
        executable
            .parent()
            .and_then(Path::parent)
            .unwrap_or_else(|| Path::new(""))
            .join("Frameworks/libkrunfw.5.dylib")
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = executable;
        let target = match std::env::consts::ARCH {
            "aarch64" => "aarch64-unknown-linux-gnu",
            "x86_64" => "x86_64-unknown-linux-gnu",
            _ => "unsupported-target",
        };
        resource_dir
            .join("microsandbox")
            .join(target)
            .join("lib/libkrunfw.so.5.6.1")
    }
}

fn runtime_home_alias(user_home: &Path, storage_home: &Path) -> PathBuf {
    let digest = Sha256::digest(storage_home.as_os_str().as_encoded_bytes());
    user_home
        .join(".silo")
        .join(format!("{:x}", digest)[..12].to_string())
}

pub(crate) fn prepare_runtime_home(
    home: &Path,
    storage_home: Option<&Path>,
) -> Result<(), RuntimeError> {
    let prepare = || -> std::io::Result<()> {
        let Some(storage_home) = storage_home else {
            return fs::create_dir_all(home);
        };
        let maximum = if cfg!(target_os = "macos") { 103 } else { 107 };
        let longest_socket = home.join("run/sandboxes/000000000000000000000000/control.sock");
        if longest_socket.as_os_str().as_encoded_bytes().len() > maximum {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "This account's home path is too long for MicroSandbox Unix sockets.",
            ));
        }
        let parent = home.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "The Silo runtime alias path is invalid.",
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, MetadataExt};
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            match builder.create(parent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            let metadata = fs::symlink_metadata(parent)?;
            if !metadata.is_dir()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o022 != 0
            {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Silo's runtime alias directory must be owned by this account and not writable by other users."));
            }
            match fs::symlink_metadata(home) {
                Ok(metadata) => {
                    if !metadata.file_type().is_symlink()
                        || metadata.uid() != unsafe { libc::geteuid() }
                        || fs::read_link(home)? != storage_home
                    {
                        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "Silo's runtime alias already points elsewhere. No existing data was changed."));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::os::unix::fs::symlink(storage_home, home)?
                }
                Err(error) => return Err(error),
            }
        }
        fs::create_dir_all(storage_home)
    };
    prepare().map_err(|error| {
        RuntimeError::Unavailable(format!(
            "Silo could not prepare its managed runtime path: {error}"
        ))
    })
}

struct SetupRunner<'a> {
    request_id: &'a str,
    publish: &'a dyn Fn(MachineConfigurationProgress),
}

impl RuntimeRunner for SetupRunner<'_> {
    fn run(
        &self,
        paths: &RuntimePaths,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, RuntimeError> {
        let workspace = args
            .windows(2)
            .find(|pair| pair[0] == "--name")
            .map(|pair| pair[1].as_str())
            .unwrap_or("");
        let layers = Mutex::new(HashMap::<u64, u64>::new());
        let total = Mutex::new(None::<u64>);
        run_msb_with_progress(paths, args, timeout, &|value| {
            let Some(phase) = value.get("phase").and_then(Value::as_str) else {
                return;
            };
            let message = match phase {
                "image-resolving" => "Resolving the VM image…",
                "image-resolved" => "VM image resolved; preparing the download…",
                "image-download" => "Downloading the VM image…",
                "image-downloaded" => "VM image layer downloaded.",
                "image-verifying" => "Checking the downloaded image…",
                "image-preparing" => "Preparing the VM image on disk…",
                "image-ready" => {
                    "VM image ready; preparing the system disk and runtime configuration…"
                }
                "runtime-waiting" => "Waiting for the runtime to finish preparing the VM…",
                _ => return,
            };
            let mut event = machine_progress(self.request_id, phase, workspace, 0);
            event.fraction = None;
            event.message = if workspace.is_empty() {
                message.into()
            } else {
                format!("{workspace}: {message}")
            };
            if phase == "image-resolved" {
                *total.lock().unwrap() = value.get("totalBytes").and_then(Value::as_u64);
            }
            if matches!(phase, "image-download" | "image-downloaded") {
                if let (Some(index), Some(bytes)) = (
                    value.get("layerIndex").and_then(Value::as_u64),
                    value.get("downloadedBytes").and_then(Value::as_u64),
                ) {
                    let mut layers = layers.lock().unwrap();
                    if layers.len() < 1024 || layers.contains_key(&index) {
                        layers.insert(index, bytes);
                        event.downloaded_bytes =
                            Some(layers.values().copied().fold(0u64, u64::saturating_add));
                        event.total_bytes = *total.lock().unwrap();
                    }
                }
            }
            (self.publish)(event);
        })
    }
}

pub(crate) fn run_msb(
    paths: &RuntimePaths,
    args: &[String],
    timeout: Duration,
) -> Result<CommandOutput, RuntimeError> {
    run_msb_with_progress(paths, args, timeout, &|_| {})
}

fn run_msb_with_progress(
    paths: &RuntimePaths,
    args: &[String],
    timeout: Duration,
    report: &dyn Fn(Value),
) -> Result<CommandOutput, RuntimeError> {
    if let Some(workspace) = args.get(1).filter(|workspace| {
        validate_name(workspace).is_ok()
            && matches!(
                args.first().map(String::as_str),
                Some("start" | "restart" | "exec")
            )
    }) {
        let lock =
            github_revision_lock(&paths.home, workspace).map_err(RuntimeError::Unavailable)?;
        let guard = lock.lock().map_err(|_| {
            RuntimeError::Unavailable("GitHub runtime state is unavailable.".into())
        })?;
        if args[0] != "exec" {
            return run_msb_process(paths, args, timeout, report);
        }
        // Finish a possible boot under the same lock as live access changes,
        // then release it before running arbitrary, possibly long guest commands.
        let state = inspect_workspace(&ProcessRunner, paths, workspace)?;
        let temporary_boot = matches!(state.status.as_str(), "Created" | "Stopped" | "Crashed");
        if temporary_boot {
            run_msb_process(
                paths,
                &["start".into(), workspace.clone()],
                MUTATION_TIMEOUT,
                report,
            )?;
        }
        drop(guard);
        let result = run_msb_process(paths, args, timeout, report);
        if temporary_boot {
            // Preserve msb exec's temporary-boot behavior even on guest failure.
            let _guard = lock.lock().map_err(|_| {
                RuntimeError::Unavailable("GitHub runtime state is unavailable.".into())
            })?;
            let stopped = run_msb_process(
                paths,
                &["stop".into(), workspace.clone()],
                STOP_TIMEOUT,
                &|_| {},
            );
            return match (result, stopped) {
                (Ok(output), Ok(_)) => Ok(output),
                (Err(error), Ok(_)) => Err(error),
                (Ok(_), Err(error)) => Err(error),
                (Err(error), Err(cleanup)) => Err(RuntimeError::Unavailable(format!(
                    "{error} Stopping the temporary sandbox also failed: {cleanup}"
                ))),
            };
        }
        return result;
    }
    run_msb_process(paths, args, timeout, report)
}

fn run_msb_process(
    paths: &RuntimePaths,
    args: &[String],
    timeout: Duration,
    report: &dyn Fn(Value),
) -> Result<CommandOutput, RuntimeError> {
    for (description, path) in [
        ("bundled MicroSandbox executable", &paths.executable),
        ("bundled MicroSandbox library", &paths.library),
    ] {
        if !path.is_file() {
            return Err(RuntimeError::Unavailable(format!(
                "The {description} is unavailable in this Silo installation."
            )));
        }
    }
    prepare_runtime_home(&paths.home, paths.storage_home.as_deref())?;
    let stdout_file = tempfile::NamedTempFile::new().map_err(|error| {
        RuntimeError::Unavailable(format!("Silo could not capture runtime output: {error}"))
    })?;
    let stderr_file = tempfile::NamedTempFile::new().map_err(|error| {
        RuntimeError::Unavailable(format!("Silo could not capture runtime errors: {error}"))
    })?;
    let mut child = Command::new(&paths.executable)
        .args(args)
        .env("MSB_HOME", &paths.home)
        .env("MSB_PATH", &paths.executable)
        .env("MSB_LIBKRUNFW_PATH", &paths.library)
        .env("SILO_GITHUB", github_environment(paths, args))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file.as_file().try_clone().map_err(
            |error| {
                RuntimeError::Unavailable(format!("Silo could not capture runtime output: {error}"))
            },
        )?))
        .stderr(Stdio::from(stderr_file.as_file().try_clone().map_err(
            |error| {
                RuntimeError::Unavailable(format!("Silo could not capture runtime errors: {error}"))
            },
        )?))
        .spawn()
        .map_err(|error| {
            RuntimeError::Unavailable(format!("Silo could not start its bundled runtime: {error}"))
        })?;
    let deadline = Instant::now() + timeout;
    let mut progress_offset = 0;
    let mut progress_pending = String::new();
    let mut next_progress = Instant::now();
    let mut last_progress = Instant::now();
    let mut last_phase = serde_json::json!({"phase": "runtime-waiting"});
    let mut exited = None;
    let status = loop {
        if args.iter().any(|arg| arg == "--progress-json") && Instant::now() >= next_progress {
            next_progress = Instant::now() + Duration::from_secs(1);
            if let Ok(mut capture) = stderr_file.reopen() {
                let _ = capture.seek(SeekFrom::Start(progress_offset));
                let mut bytes = Vec::new();
                if capture
                    .take(MAX_OUTPUT_BYTES)
                    .read_to_end(&mut bytes)
                    .is_ok()
                {
                    progress_offset += bytes.len() as u64;
                    progress_pending.push_str(&String::from_utf8_lossy(&bytes));
                    let mut latest = None;
                    while let Some(end) = progress_pending.find('\n') {
                        let line: String = progress_pending.drain(..=end).collect();
                        if let Ok(value) = serde_json::from_str::<Value>(&line) {
                            if value.get("type").and_then(Value::as_str) == Some("silo-progress") {
                                // Keep phase boundaries; collapse repeated chunk updates within this poll.
                                if latest.as_ref().is_some_and(|old: &Value| {
                                    old.get("phase") != value.get("phase")
                                        || old.get("layerIndex") != value.get("layerIndex")
                                }) {
                                    report(latest.take().unwrap());
                                }
                                latest = Some(value);
                            }
                        }
                    }
                    if let Some(value) = latest {
                        last_phase = value.clone();
                        report(value);
                        last_progress = Instant::now();
                    }
                }
            }
            if last_progress.elapsed() >= Duration::from_secs(5) {
                report(last_phase.clone());
                last_progress = Instant::now();
            }
        }
        if stdout_file
            .as_file()
            .metadata()
            .map(|value| value.len())
            .unwrap_or(0)
            > MAX_OUTPUT_BYTES
            || stderr_file
                .as_file()
                .metadata()
                .map(|value| value.len())
                .unwrap_or(0)
                > MAX_OUTPUT_BYTES
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RuntimeError::Failed {
                operation: operation_name(args),
                detail: "the runtime returned too much output".into(),
            });
        }
        if let Some(status) = exited.take() {
            break status;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exited = Some(status);
                next_progress = Instant::now();
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RuntimeError::TimedOut {
                    operation: operation_name(args),
                });
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RuntimeError::Failed {
                    operation: operation_name(args),
                    detail: format!("the process could not be observed: {error}"),
                });
            }
        }
    };
    let stdout = read_capture(stdout_file.into_file())?;
    let stderr = read_capture(stderr_file.into_file())?;
    if !status.success() {
        let stderr_detail = runtime_error_text(&stderr);
        let stdout_detail = runtime_error_text(&stdout);
        let raw_detail = if stderr_detail.trim().is_empty() {
            &stdout_detail
        } else {
            &stderr_detail
        };
        return Err(RuntimeError::Failed {
            operation: operation_name(args),
            detail: format!(
                "exit code {}: {}",
                status.code().unwrap_or(-1),
                clean_detail(raw_detail, &paths.home)
            ),
        });
    }
    Ok(CommandOutput { stdout, stderr })
}

fn runtime_error_text(capture: &str) -> String {
    capture
        .lines()
        .filter(|line| {
            !serde_json::from_str::<Value>(line)
                .ok()
                .is_some_and(|event| {
                    event.get("type").and_then(Value::as_str) == Some("silo-progress")
                })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn mentions_http_status(detail: &str, status: &str) -> bool {
    let words: Vec<_> = detail
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    words
        .windows(2)
        .any(|pair| matches!(pair[0], "http" | "status") && pair[1] == status)
        || words
            .windows(3)
            .any(|parts| parts[0] == "status" && parts[1] == "code" && parts[2] == status)
}

fn read_capture(mut file: File) -> Result<String, RuntimeError> {
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        RuntimeError::Unavailable(format!("Silo could not read runtime output: {error}"))
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            RuntimeError::Unavailable(format!("Silo could not read runtime output: {error}"))
        })?;
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(RuntimeError::Malformed(
            "The bundled runtime returned too much output.".into(),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| RuntimeError::Malformed("The bundled runtime returned invalid text.".into()))
}

fn operation_name(args: &[String]) -> String {
    match args.first().map(String::as_str) {
        Some("create") => "Creating the sandbox".into(),
        Some("start") => "Starting the sandbox".into(),
        Some("stop") => "Stopping the sandbox".into(),
        Some("restart") => "Restarting the sandbox".into(),
        Some("modify") => "Updating the sandbox".into(),
        Some("remove") => "Removing the sandbox".into(),
        Some("inspect") | Some("list") => "Reading sandbox state".into(),
        _ => "The sandbox operation".into(),
    }
}

fn clean_detail(detail: &str, home: &Path) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        return "the bundled runtime did not provide an error message".into();
    }
    detail.replace(home.to_string_lossy().as_ref(), "Silo managed storage")
}

fn host_resources() -> Result<HostResources, RuntimeError> {
    let logical_cpus = thread::available_parallelism()
        .map_err(|error| {
            RuntimeError::Unavailable(format!("Silo could not inspect host CPUs: {error}"))
        })?
        .get();
    Ok(HostResources {
        logical_cpus,
        physical_memory_bytes: physical_memory_bytes()?,
    })
}

#[cfg(target_os = "macos")]
fn physical_memory_bytes() -> Result<Option<u64>, RuntimeError> {
    let name = CString::new("hw.memsize").expect("static sysctl name");
    let mut value = 0_u64;
    let mut length = std::mem::size_of::<u64>();
    // SAFETY: `name` is NUL-terminated and both output pointers refer to
    // writable values of the declared length for the duration of the call.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result == 0 && length == std::mem::size_of::<u64>() && value > 0 {
        Ok(Some(value))
    } else {
        Err(RuntimeError::Unavailable(
            "Silo could not measure physical memory for this sandbox operation.".into(),
        ))
    }
}

#[cfg(target_os = "linux")]
fn physical_memory_bytes() -> Result<Option<u64>, RuntimeError> {
    // SAFETY: zero is a valid initial bit pattern for `libc::sysinfo`, and the
    // kernel writes the complete structure through the exclusive pointer.
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::sysinfo(&mut info) };
    let bytes = (info.totalram as u64).checked_mul(u64::from(info.mem_unit));
    if result == 0 && bytes.is_some_and(|value| value > 0) {
        Ok(bytes)
    } else {
        Err(RuntimeError::Unavailable(
            "Silo could not measure physical memory for this sandbox operation.".into(),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn physical_memory_bytes() -> Result<Option<u64>, RuntimeError> {
    Err(RuntimeError::Unavailable(
        "Local MicroSandbox VMs are unavailable on this operating system.".into(),
    ))
}

fn validate_requested_resources(
    request: &MachineConfigurationRequest,
    host: &HostResources,
) -> Result<(), RuntimeError> {
    for machine in &request.machines {
        let MachineConfiguration::Vm {
            name,
            max_cpus,
            max_memory_gib,
            ..
        } = machine
        else {
            continue;
        };
        validate_host_ceiling(name, *max_cpus, *max_memory_gib, host)?;
    }
    Ok(())
}

fn validate_inspected_resources(
    name: &str,
    config: &Value,
    host: &HostResources,
) -> Result<(), RuntimeError> {
    let max_cpus = config
        .pointer("/resources/max_cpus")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .ok_or_else(|| {
            RuntimeError::Malformed(format!(
                "Sandbox '{name}' does not report a valid CPU ceiling. It was not started."
            ))
        })?;
    let max_memory_mib = config
        .pointer("/resources/max_memory_mib")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            RuntimeError::Malformed(format!(
                "Sandbox '{name}' does not report a valid memory ceiling. It was not started."
            ))
        })?;
    let max_memory_gib = u32::try_from(max_memory_mib.div_ceil(1024)).map_err(|_| {
        RuntimeError::Malformed(format!(
            "Sandbox '{name}' reports an invalid memory ceiling. It was not started."
        ))
    })?;
    validate_host_ceiling(name, max_cpus, max_memory_gib, host)
}

fn validate_host_ceiling(
    name: &str,
    max_cpus: u8,
    max_memory_gib: u32,
    host: &HostResources,
) -> Result<(), RuntimeError> {
    if max_cpus == 0 || max_memory_gib == 0 || host.logical_cpus == 0 {
        return Err(RuntimeError::Unavailable(
            "Silo could not verify valid host and sandbox resource limits.".into(),
        ));
    }
    let physical = host
        .physical_memory_bytes
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            RuntimeError::Unavailable(
                "Silo could not verify physical memory for this sandbox operation.".into(),
            )
        })?;
    if usize::from(max_cpus) > host.logical_cpus {
        return Err(RuntimeError::Invalid(format!(
            "Sandbox '{name}' has a {max_cpus} CPU ceiling, but this host reports {} logical CPUs. No sandbox was started or changed.",
            host.logical_cpus
        )));
    }
    let requested_memory = u64::from(max_memory_gib)
        .checked_mul(1024 * 1024 * 1024)
        .ok_or_else(|| {
            RuntimeError::Invalid(format!("Sandbox '{name}' requests too much memory."))
        })?;
    if requested_memory > physical {
        return Err(RuntimeError::Invalid(format!(
            "Sandbox '{name}' has a {max_memory_gib} GiB memory ceiling, but this host reports {} GiB of physical memory. No sandbox was started or changed.",
            physical / (1024 * 1024 * 1024)
        )));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceIdentity {
    workspace: String,
    name: String,
    email: String,
    apply: bool,
}

#[tauri::command]
pub async fn verify_workspace_identities(
    app: AppHandle,
    identities: Vec<WorkspaceIdentity>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&app)?;
        let _guard = MUTATION_LOCK
            .try_lock()
            .map_err(|_| RuntimeError::Busy.to_string())?;
        verify_workspace_identities_with(&ProcessRunner, &paths, &identities)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Git identity verification worker failed: {error}"))?
}

fn verify_workspace_identities_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    identities: &[WorkspaceIdentity],
) -> Result<bool, RuntimeError> {
    if identities.is_empty() || identities.len() > MAX_MACHINE_COUNT {
        return Ok(false);
    }
    let metadata = read_metadata(&paths.metadata)?;
    let mut names = HashSet::new();
    for identity in identities {
        validate_name(&identity.workspace)?;
        if !names.insert(&identity.workspace)
            || !metadata
                .machines
                .iter()
                .any(|machine| machine.name() == identity.workspace)
        {
            return Ok(false);
        }
        if !metadata
            .machines
            .iter()
            .any(|machine| machine.name() == identity.workspace && machine.is_vm())
        {
            return Ok(false);
        }
        let inspected = inspect_workspace(runner, paths, &identity.workspace)?;
        ensure_managed(&inspected)?;
        if !identity.apply {
            continue;
        }
        if [&identity.name, &identity.email].iter().any(|value| {
            value.trim().is_empty() || value.len() > 1024 || value.chars().any(char::is_control)
        }) {
            return Ok(false);
        }
        if !verify_guest_identity(runner, paths, identity)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn configure_workspace_identities(
    app: AppHandle,
    identities: Vec<WorkspaceIdentity>,
) -> Result<(), String> {
    let notify_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&app)?;
        let _guard = MUTATION_LOCK
            .try_lock()
            .map_err(|_| RuntimeError::Busy.to_string())?;
        let result = configure_workspace_identities_with(&ProcessRunner, &paths, &identities);
        result.map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Git identity worker failed: {error}"))
    .and_then(|result| result);
    if result.is_err() {
        crate::notifications::action_failed(&notify_app, "Git identity setup failed");
    }
    result
}

fn configure_workspace_identities_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    identities: &[WorkspaceIdentity],
) -> Result<(), RuntimeError> {
    if identities.len() > MAX_MACHINE_COUNT {
        return Err(RuntimeError::Invalid("Too many sandbox identities.".into()));
    }
    let metadata = read_metadata(&paths.metadata)?;
    let mut names = HashSet::new();
    let mut changed = Vec::new();
    for identity in identities.iter().filter(|identity| identity.apply) {
        validate_name(&identity.workspace)?;
        if !names.insert(&identity.workspace)
            || [&identity.name, &identity.email].iter().any(|value| {
                value.trim().is_empty() || value.len() > 1024 || value.chars().any(char::is_control)
            })
        {
            return Err(RuntimeError::Invalid(
                "Each sandbox needs one valid Git name and email address.".into(),
            ));
        }
        if !metadata
            .machines
            .iter()
            .any(|machine| machine.name() == identity.workspace && machine.is_vm())
        {
            return Err(RuntimeError::Invalid(format!(
                "Sandbox '{}' is not a configured local VM. Its Git identity was not changed.",
                identity.workspace
            )));
        }
        let inspected = inspect_workspace(runner, paths, &identity.workspace)?;
        ensure_managed(&inspected)?;
        changed.push(identity);
    }
    for identity in changed {
        // Remove old boot overrides: normal Git/jj configuration must own defaults.
        let mut args = vec!["modify".into(), identity.workspace.clone()];
        for key in [
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_NAME",
            "GIT_COMMITTER_EMAIL",
            "JJ_USER",
            "JJ_EMAIL",
        ] {
            args.extend(["--env-rm".into(), key.into()]);
        }
        args.extend(["--format".into(), "json".into()]);
        runner.run(paths, &args, MUTATION_TIMEOUT)?;
        let script = r#"set -eu
 git config --global -- user.name "$1"
 git config --global -- user.email "$2"
 if command -v jj >/dev/null 2>&1; then
   jj config set --user -- user.name "$3"
   jj config set --user -- user.email "$4"
 fi"#;
        run_identity_script(runner, paths, identity, script)?;
        if !verify_guest_identity(runner, paths, identity)? {
            return Err(RuntimeError::Malformed(format!(
                "Silo could not verify the saved Git identity for '{}'. Setup is not complete.",
                identity.workspace
            )));
        }
    }
    Ok(())
}

fn run_identity_script(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    identity: &WorkspaceIdentity,
    script: &str,
) -> Result<CommandOutput, RuntimeError> {
    // exec starts stopped sandboxes temporarily and preserves already-running VMs.
    // Values are positional arguments, never interpolated shell source.
    runner.run(
        paths,
        &[
            "exec".into(),
            identity.workspace.clone(),
            "--no-tty".into(),
            "--workdir".into(),
            "/".into(),
            "--quiet".into(),
            "--timeout".into(),
            "30s".into(),
            "--".into(),
            "sh".into(),
            "-c".into(),
            script.into(),
            "silo-git-identity".into(),
            identity.name.clone(),
            identity.email.clone(),
            serde_json::to_string(&identity.name)
                .map_err(|_| RuntimeError::Invalid("Invalid Git name.".into()))?,
            serde_json::to_string(&identity.email)
                .map_err(|_| RuntimeError::Invalid("Invalid Git email.".into()))?,
        ],
        MUTATION_TIMEOUT,
    )
}

fn verify_guest_identity(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    identity: &WorkspaceIdentity,
) -> Result<bool, RuntimeError> {
    let script = r#"set -eu
 if [ "$(git config --global --get user.name)" != "$1" ] ||
    [ "$(git config --global --get user.email)" != "$2" ]; then exit 0; fi
 if command -v jj >/dev/null 2>&1; then
   [ "$(jj config get user.name)" = "$1" ] || exit 0
   [ "$(jj config get user.email)" = "$2" ] || exit 0
 fi
 printf '%s' silo-identity-verified"#;
    Ok(run_identity_script(runner, paths, identity, script)?
        .stdout
        .trim()
        == "silo-identity-verified")
}

/// Host-only retirement material; never serialize this result to the frontend.
pub(crate) fn scoped_cached_tokens(
    app: &AppHandle,
    workspace: &str,
) -> Result<Vec<String>, String> {
    let paths = runtime_paths(app)?;
    let cache = GITHUB_PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
    let profiles = cache
        .lock()
        .map_err(|_| "GitHub runtime state is unavailable.")?;
    let Some(raw) = profiles.get(&(paths.home, workspace.into())) else {
        return Ok(Vec::new());
    };
    let profile: Value = serde_json::from_str(raw).map_err(|_| "Invalid cached GitHub state.")?;
    let mut tokens = Vec::new();
    for owner in profile["owners"]
        .as_array()
        .ok_or("Invalid cached GitHub grants.")?
    {
        for key in ["readToken", "writeToken"] {
            if let Some(token) = owner[key].as_str() {
                if !tokens.iter().any(|existing| existing == token) {
                    tokens.push(token.into());
                }
            }
        }
    }
    Ok(tokens)
}

/// A managed VM receives credentials through a host-only environment reference.
/// The JSON profile is never a command argument, a config value or captured log.
pub(crate) fn apply_github_policy(
    app: &AppHandle,
    workspace: &str,
    revision: u64,
    profiles: &Value,
) -> Result<(), String> {
    validate_name(workspace).map_err(|error| error.to_string())?;
    if profiles["version"] != 1 || !profiles["owners"].is_array() {
        return Err("Invalid GitHub access profile.".into());
    }
    let paths = runtime_paths(app)?;
    // GitHub policy updates must not wait for VM lifecycle or network operations.
    // Serialize only this VM's local updates and reject delayed older revisions.
    let revision_lock = github_revision_lock(&paths.home, workspace)?;
    let mut current_revision = revision_lock
        .lock()
        .map_err(|_| "GitHub runtime state is unavailable.")?;
    accept_github_revision(&mut current_revision, revision)?;
    // Even a failed runtime update must not leave a stale credential available
    // for the next start. Active-connection acknowledgement is checked below.
    let cache = GITHUB_PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
    cache
        .lock()
        .map_err(|_| "GitHub runtime state is unavailable.")?
        .remove(&(paths.home.clone(), workspace.into()));
    let capability =
        run_msb(&paths, &["--silo-github-protocol".into()], READ_TIMEOUT).map_err(|_| {
            "This Silo runtime must be updated before GitHub access can be enabled.".to_string()
        })?;
    if capability.stdout.trim() != "1" {
        return Err("This runtime does not support Silo GitHub permissions.".into());
    }
    let inspected =
        inspect_workspace(&ProcessRunner, &paths, workspace).map_err(|error| error.to_string())?;
    ensure_managed(&inspected).map_err(|error| error.to_string())?;
    if inspected
        .config
        .pointer("/labels/silo.github-protocol")
        .and_then(Value::as_str)
        != Some("1")
    {
        return Err(
            "Recreate this development sandbox to enable the new GitHub integration.".into(),
        );
    }
    let profile =
        serde_json::to_string(profiles).map_err(|_| "Cannot prepare GitHub access.".to_string())?;
    if profile.len() > 128 * 1024 {
        return Err("GitHub access profile is too large.".into());
    }
    // Discard any previous boot credential before attempting an update. A failed
    // update must never restore stale credentials on a subsequent VM start.
    let cache = GITHUB_PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
    cache
        .lock()
        .map_err(|_| "GitHub runtime state is unavailable.".to_string())?
        .remove(&(paths.home.clone(), workspace.into()));
    let mut child = Command::new(&paths.executable)
        .args([
            "modify",
            workspace,
            "--secret",
            "SILO_GITHUB@github.com,api.github.com,uploads.github.com",
            "--format",
            "json",
        ])
        .env("MSB_HOME", &paths.home)
        .env("MSB_PATH", &paths.executable)
        .env("MSB_LIBKRUNFW_PATH", &paths.library)
        .env("SILO_GITHUB", &profile)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not apply GitHub access to the sandbox.".to_string())?;
    let deadline = Instant::now() + MUTATION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err(
                "The sandbox rejected the GitHub access update. Retry after checking its state."
                    .into(),
            ),
            Err(_) => return Err("Could not verify the GitHub access update.".into()),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Applying GitHub access timed out; it was not marked complete.".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
        }
    }
    cache
        .lock()
        .map_err(|_| "GitHub runtime state is unavailable.".to_string())?
        .insert((paths.home.clone(), workspace.into()), profile);
    Ok(())
}

pub(crate) fn apply_github_identity(
    app: &AppHandle,
    workspace: &str,
    identity: &Value,
) -> Result<(), String> {
    let _guard = MUTATION_LOCK
        .try_lock()
        .map_err(|_| RuntimeError::Busy.to_string())?;
    let paths = runtime_paths(app)?;
    let parsed: WorkspaceIdentity = serde_json::from_value(serde_json::json!({
        "workspace": workspace, "name": identity["name"], "email": identity["email"], "apply": identity["apply"]
    })).map_err(|_| "Invalid Git author configuration.".to_string())?;
    configure_workspace_identities_with(&ProcessRunner, &paths, &[parsed])
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn read_machine_configuration(
    app: AppHandle,
) -> Result<MachineConfigurationRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&app)?;
        // Saved names and resources can render before live VM inspection finishes.
        // This command does not infer or return a running/stopped state.
        read_metadata(&paths.metadata).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_application_state(app: AppHandle) -> Result<ApplicationSource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&app)?;
        let mut source = read_application_state_with(&ProcessRunner, &paths)
            .map_err(|error| error.to_string())?;
        source.repository_push_operations = crate::host_push::operations();
        for workspace in &mut source.workspaces {
            if workspace.machine.is_vm() && matches!(workspace.state, WorkspaceState::Running) {
                match crate::host_push::discover(&paths, workspace.machine.name()) {
                    Ok(repositories) => workspace.repositories = repositories,
                    Err(message) => {
                        if workspace.attention.is_none() {
                            workspace.attention = Some(WorkspaceAttention { level: AttentionLevel::Warning, message });
                        }
                    }
                }
            }
        }
        source.github = crate::github::snapshot(&app).unwrap_or_else(|message| serde_json::json!({
            "state": "disconnected", "accessEnabled": false, "repositoryCatalog": [],
            "repositoryCatalogStatus": {"status": "unavailable", "message": message, "canRetry": true},
            "workspaceOperations": [], "hostIdentity": crate::host_identity::read(),
        }));
        Ok(source)
    })
    .await
    .map_err(|error| format!("Sandbox state worker failed: {error}"))?
}

/// A background health observation uses the same real inspection as the UI, without
/// host identity discovery. Never hold the mutation lock while inspecting: user
/// actions take priority. Discard observations overlapping an ongoing mutation or
/// metadata change. No sandbox is created, started, or changed here.
pub(crate) fn health_observations(
    app: &AppHandle,
) -> Option<crate::notifications::HealthObservations> {
    drop(MUTATION_LOCK.try_lock().ok()?);
    struct HealthRunner(Instant);
    impl RuntimeRunner for HealthRunner {
        fn run(
            &self,
            paths: &RuntimePaths,
            args: &[String],
            timeout: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            let remaining = Duration::from_secs(5)
                .checked_sub(self.0.elapsed())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| RuntimeError::TimedOut {
                    operation: "Health check".into(),
                })?;
            if !paths.home.is_dir()
                || paths
                    .storage_home
                    .as_ref()
                    .is_some_and(|home| !home.is_dir())
            {
                return Err(RuntimeError::Unavailable(
                    "The managed runtime is unavailable.".into(),
                ));
            }
            run_msb(paths, args, timeout.min(remaining))
        }
    }
    let paths = runtime_paths(app);
    let before = paths
        .as_ref()
        .ok()
        .and_then(|paths| fs::read(&paths.metadata).ok());
    let source = paths.as_ref().map_err(Clone::clone).and_then(|paths| {
        read_application_state_with(&HealthRunner(Instant::now()), paths)
            .map_err(|error| error.to_string())
    });
    drop(MUTATION_LOCK.try_lock().ok()?);
    let after = paths
        .as_ref()
        .ok()
        .and_then(|paths| fs::read(&paths.metadata).ok());
    if before != after {
        return None;
    }
    let mut observations = std::collections::HashMap::new();
    observations.insert(
        "runtime".into(),
        (
            "Silo".into(),
            if source.is_err() {
                "Health checks unavailable"
            } else {
                "Health checks available"
            },
        ),
    );
    if let Ok(source) = source {
        for workspace in source
            .workspaces
            .into_iter()
            .filter(|workspace| workspace.machine.is_vm())
        {
            let state = if workspace.attention.is_some() {
                "Health or configuration check failed"
            } else {
                match workspace.state {
                    WorkspaceState::Running => "Running",
                    WorkspaceState::Stopped => "Stopped",
                    WorkspaceState::Starting => "Starting",
                    WorkspaceState::Failed => "Failed",
                }
            };
            observations.insert(
                format!("vm:{}", workspace.machine.id()),
                (workspace.machine.name().into(), state),
            );
        }
    }
    Some(observations)
}

#[tauri::command]
pub fn workspace_action(
    app: AppHandle,
    action: String,
    name: String,
) -> Result<ApplicationSource, String> {
    let result = (|| {
        let paths = runtime_paths(&app)?;
        let guard = MUTATION_LOCK
            .try_lock()
            .map_err(|_| RuntimeError::Busy.to_string())?;
        let result = host_resources()
            .and_then(|resources| {
                workspace_action_with(&ProcessRunner, &paths, &resources, &action, &name)
            })
            .and_then(|_| read_application_state_with(&ProcessRunner, &paths));
        drop(guard);
        result.map_err(|error| error.to_string())
    })();
    if result.is_err() {
        crate::notifications::action_failed(&app, "Sandbox action failed");
    }
    result
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConfigurationProgress {
    schema_version: u8,
    #[serde(rename = "type")]
    event_type: String,
    request_id: String,
    phase: String,
    step: String,
    workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fraction: Option<u8>,
    message: String,
    safe_for_display: bool,
    timestamp: u64,
    level: String,
    elapsed_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

fn machine_progress(
    request_id: &str,
    step: &str,
    workspace: &str,
    fraction: u8,
) -> MachineConfigurationProgress {
    let message = match (step, fraction) {
        ("workspace-configuration", 0) => format!("Configuring {workspace}…"),
        ("workspace-configuration", _) => format!("{workspace} configured."),
        ("workspace-verification", 0) => format!("Verifying {workspace}…"),
        ("workspace-verification", _) => format!("{workspace} verified."),
        ("workspace-disk-preparation", _) => format!("Preparing {workspace}'s workspace disk…"),
        ("workspace-runtime-preparation", _) => {
            format!("Preparing {workspace}'s VM image and system disk…")
        }
        ("workspace-settings", _) => format!("Saving {workspace}'s configuration…"),
        ("setup-started", _) => "Sandbox setup started.".into(),
        ("setup-completed", _) => "Sandbox setup completed.".into(),
        ("setup-failed", _) => "Sandbox setup failed.".into(),
        ("setup-interrupted", _) => {
            "Sandbox setup was interrupted when Silo closed. Check the sandbox state, then retry."
                .into()
        }
        ("workspace-removal", 0) => format!("Removing {workspace}…"),
        _ => format!("{workspace} removed."),
    };
    MachineConfigurationProgress {
        schema_version: 1,
        event_type: "progress".into(),
        request_id: request_id.into(),
        phase: "workspaces".into(),
        step: step.into(),
        workspace: workspace.into(),
        fraction: (!step.starts_with("setup-")
            && matches!(
                step,
                "workspace-configuration" | "workspace-verification" | "workspace-removal"
            ))
        .then_some(fraction),
        message,
        safe_for_display: true,
        timestamp: activity_timestamp(),
        level: "info".into(),
        elapsed_seconds: 0,
        downloaded_bytes: None,
        total_bytes: None,
        failure_code: None,
        exit_code: None,
    }
}

fn activity_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn activity_path(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("setup-activity.json")
}

fn failure_code(error: &RuntimeError) -> &'static str {
    let lower = error.to_string().to_lowercase();
    if lower.contains("unauthorized")
        || lower.contains("authentication")
        || mentions_http_status(&lower, "401")
    {
        "auth"
    } else if lower.contains("forbidden") || mentions_http_status(&lower, "403") {
        "access"
    } else if lower.contains("no space left") {
        "disk"
    } else if lower.contains("permission denied") || lower.contains("permission was denied") {
        "permission"
    } else if lower.contains("connection")
        || lower.contains("dns")
        || lower.contains("error sending request")
    {
        "network"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("digest") || lower.contains("checksum") {
        "integrity"
    } else if lower.contains("cpu")
        || lower.contains("memory")
        || lower.contains("storage allocation")
        || lower.contains("resource")
    {
        "resources"
    } else if matches!(
        error,
        RuntimeError::Invalid(_) | RuntimeError::Malformed(_) | RuntimeError::Busy
    ) {
        "configuration"
    } else if matches!(error, RuntimeError::Unavailable(_)) {
        "unavailable"
    } else {
        "runtime"
    }
}

fn failure_message(code: &str, exit_code: Option<i32>) -> Option<String> {
    let reason = match code {
        "auth" => "The image registry rejected authentication. Check registry access and retry.",
        "access" => "The image registry denied access. Check registry access and retry.",
        "disk" => "Not enough free disk space. Free some space and retry.",
        "permission" => "Permission was denied. Check access to Silo's storage and retry.",
        "network" => "The image registry could not be reached. Check your internet connection and retry.",
        "timeout" => "The operation timed out. Check the sandbox state and retry.",
        "integrity" => "The downloaded image failed its integrity check. Retry the download.",
        "resources" => "Sandbox CPU, memory, or storage limits could not be validated. Review the sandbox resources against this computer's limits and retry.",
        "configuration" => "The sandbox configuration could not be applied or verified. Review its settings and current state before retrying.",
        "unavailable" => "A required runtime or host resource is unavailable. Check Silo's Dependencies screen before retrying.",
        "runtime" => "The runtime did not complete the operation. Check the sandbox state and retry.",
        _ => return None,
    };
    Some(match exit_code {
        Some(code) => format!("Sandbox setup failed (exit code {code}): {reason}"),
        None => format!("Sandbox setup failed: {reason}"),
    })
}

fn runtime_exit_code(error: &RuntimeError) -> Option<i32> {
    let RuntimeError::Failed { detail, .. } = error else {
        return None;
    };
    detail
        .split("exit code ")
        .nth(1)?
        .split(|ch: char| ch != '-' && !ch.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

fn safe_activity_error(error: &RuntimeError) -> String {
    match error {
        RuntimeError::Failed { operation, detail } => {
            let lower = detail.to_lowercase();
            let reason = if lower.contains("unauthorized")
                || lower.contains("authentication")
                || mentions_http_status(&lower, "401")
            {
                "The image registry rejected authentication. Check registry access and retry."
            } else if mentions_http_status(&lower, "403")
                || lower.contains("forbidden")
                || lower.contains("denied access")
            {
                "The image registry denied access. Check registry access and retry."
            } else if lower.contains("no space left") || lower.contains("free disk space") {
                "Not enough free disk space. Free some space and retry."
            } else if lower.contains("permission denied") {
                "Permission was denied. Check access to Silo's storage and retry."
            } else if lower.contains("connection")
                || lower.contains("dns")
                || lower.contains("error sending request")
                || lower.contains("could not be reached")
            {
                "The image registry could not be reached. Check your internet connection and retry."
            } else if lower.contains("timeout") || lower.contains("timed out") {
                "The operation timed out. Check the sandbox state and retry."
            } else if lower.contains("digest")
                || lower.contains("checksum")
                || lower.contains("integrity check")
            {
                "The downloaded image failed its integrity check. Retry the download."
            } else {
                "The runtime did not complete the operation. Check the sandbox state and retry."
            };
            let exit_code = detail
                .strip_prefix("exit code ")
                .and_then(|value| value.split(':').next())
                .and_then(|value| value.parse::<i32>().ok());
            if let Some(code) = exit_code {
                format!("{operation} (exit code {code}): {reason}")
            } else {
                format!("{operation}: {reason}")
            }
        }
        RuntimeError::Busy | RuntimeError::TimedOut { .. } => error.to_string(),
        // These errors are generated by Silo, but may contain OS paths or process details.
        _ => {
            let text = error.to_string();
            text.split_whitespace()
                .map(|word| {
                    if word.contains('/')
                        || word.contains('@')
                        || word.to_lowercase().contains("token")
                        || word.contains('=')
                    {
                        "[redacted]"
                    } else {
                        word
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(800)
                .collect()
        }
    }
}

struct ActivityJournal {
    path: PathBuf,
    events: Vec<MachineConfigurationProgress>,
    started: Instant,
}

impl ActivityJournal {
    fn start(paths: &RuntimePaths, _request_id: &str) -> Result<Self, String> {
        let journal = Self {
            path: activity_path(paths),
            events: Vec::new(),
            started: Instant::now(),
        };
        // Failure to retain diagnostics must not prevent the requested setup.
        // The first append publishes a visible warning if storage is unavailable.
        Ok(journal)
    }

    fn persist(&self) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or("Silo's activity storage path is invalid.")?;
        fs::create_dir_all(parent).map_err(|_| "Silo could not prepare setup activity storage.")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Silo could not save setup activity.")?;
        serde_json::to_writer(&mut file, &self.events)
            .map_err(|_| "Silo could not encode setup activity.")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Silo could not save setup activity.")?;
        file.persist(&self.path)
            .map_err(|_| "Silo could not save setup activity.")?;
        Ok(())
    }

    fn append(&mut self, mut event: MachineConfigurationProgress) -> MachineConfigurationProgress {
        event.elapsed_seconds = self.started.elapsed().as_secs();
        // Progress updates replace the previous update for the same stage, retaining boundaries.
        if self.events.last().is_some_and(|last| {
            last.step == event.step
                && last.workspace == event.workspace
                && last.fraction.is_none()
                && !event.step.starts_with("setup-")
        }) {
            self.events.pop();
        }
        if self.events.len() >= 512 {
            self.events.remove(1);
        }
        self.events.push(event.clone());
        if self.persist().is_err() {
            let mut warning = event.clone();
            warning.level = "warning".into();
            warning.message = "Setup continues, but Silo could not retain its activity history. Copy the activity before closing Silo.".into();
            warning.step = "activity-storage-warning".into();
            warning.fraction = None;
            if self.events.len() >= 512 {
                self.events.remove(1);
            }
            self.events.push(warning);
        }
        event
    }
}

fn read_activity(
    paths: &RuntimePaths,
    recover_interrupted: bool,
) -> Result<Vec<MachineConfigurationProgress>, String> {
    let path = activity_path(paths);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(|_| "Silo could not read its setup activity history.")?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Silo could not read its setup activity history.")?;
    if bytes.len() > 1024 * 1024 {
        return Err("Silo's setup activity history is too large to read.".into());
    }
    let mut events: Vec<MachineConfigurationProgress> =
        serde_json::from_slice(&bytes).map_err(|_| "Silo's setup activity history is damaged.")?;
    if events.len() > 512
        || events.iter().any(|event| {
            event.schema_version != 1
                || event.event_type != "progress"
                || event.phase != "workspaces"
                || !event.safe_for_display
                || event.request_id.is_empty()
                || event.request_id.len() > 256
                || event.workspace.len() > 128
                || !event
                    .workspace
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "-_".contains(ch))
                || !matches!(event.level.as_str(), "info" | "warning" | "error")
                || event.fraction.is_some_and(|value| value > 1)
        })
    {
        return Err("Silo's setup activity history is invalid.".into());
    }
    for event in &mut events {
        event.message = match event.step.as_str() {
            "workspace-configuration" | "workspace-verification" | "workspace-removal" | "workspace-disk-preparation" | "workspace-runtime-preparation" | "workspace-settings" | "setup-started" | "setup-completed" | "setup-interrupted" => machine_progress(&event.request_id, &event.step, &event.workspace, event.fraction.unwrap_or(0)).message,
            "image-resolving" => format!("{}: Resolving the VM image…", event.workspace),
            "image-resolved" => format!("{}: VM image resolved; preparing the download…", event.workspace),
            "image-download" => format!("{}: Downloading the VM image…", event.workspace),
            "image-downloaded" => format!("{}: VM image layer downloaded.", event.workspace),
            "image-verifying" => format!("{}: Checking the downloaded image…", event.workspace),
            "image-preparing" => format!("{}: Preparing the VM image on disk…", event.workspace),
            "image-ready" => format!("{}: VM image ready; preparing the system disk and runtime configuration…", event.workspace),
            "runtime-waiting" => format!("{}: Waiting for the runtime to finish preparing the VM…", event.workspace),
            "host-memory-warning" => "Silo could not measure host memory. Setup can continue, but available memory could not be checked.".into(),
            "activity-storage-warning" => "Silo could not retain its activity history. Copy the activity before closing Silo.".into(),
            "setup-failed" => failure_message(event.failure_code.as_deref().unwrap_or("runtime"), event.exit_code).ok_or("Silo's setup activity history contains an unknown failure.")?,
            _ => return Err("Silo's setup activity history contains an unknown operation.".into()),
        };
    }
    if recover_interrupted
        && events
            .iter()
            .rev()
            .find(|event| event.step != "activity-storage-warning")
            .is_some_and(|event| {
                !matches!(
                    event.step.as_str(),
                    "setup-completed" | "setup-failed" | "setup-interrupted"
                )
            })
    {
        let last = events.last().unwrap();
        let mut interrupted =
            machine_progress(&last.request_id, "setup-interrupted", &last.workspace, 0);
        interrupted.level = "warning".into();
        interrupted.elapsed_seconds = last.elapsed_seconds;
        if events.len() >= 512 {
            events.remove(1);
        }
        events.push(interrupted);
        ActivityJournal {
            path,
            events: events.clone(),
            started: Instant::now(),
        }
        .persist()?;
    }
    Ok(events)
}

#[tauri::command]
pub fn read_setup_activity(app: AppHandle) -> Result<Vec<MachineConfigurationProgress>, String> {
    let paths = runtime_paths(&app)?;
    let guard = MUTATION_LOCK.try_lock().ok();
    read_activity(&paths, guard.is_some())
}

#[tauri::command]
pub async fn save_machine_configuration(
    app: AppHandle,
    request: MachineConfigurationRequest,
    request_id: Option<String>,
) -> Result<ApplicationSource, String> {
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if request_id.trim().is_empty() || request_id.len() > 256 {
        return Err("Invalid sandbox configuration request ID.".into());
    }
    let notify_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&app)?;
        let _guard = MUTATION_LOCK
            .try_lock()
            .map_err(|_| RuntimeError::Busy.to_string())?;
        let journal = Mutex::new(ActivityJournal::start(&paths, &request_id)?);
        let publish = |event: MachineConfigurationProgress| {
            let mut journal = journal.lock().unwrap_or_else(|error| error.into_inner());
            let event = journal.append(event);
            if let Some(warning) = journal.events.last().filter(|entry| entry.step == "activity-storage-warning") {
                let _ = app.emit_to("main", "silo://machine-configuration-progress", warning);
            }
            let _ = app.emit_to("main", "silo://machine-configuration-progress", &event);
        };
        publish(machine_progress(&request_id, "setup-started", "", 0));
        let progress = |step: &str, workspace: &str, fraction: u8| {
            publish(machine_progress(&request_id, step, workspace, fraction));
        };
        let result = host_resources()
            .and_then(|resources| {
                if resources.physical_memory_bytes.is_none() {
                    let mut warning = machine_progress(&request_id, "host-memory-warning", "", 0);
                    warning.level = "warning".into();
                    warning.message = "Silo could not measure host memory. Setup can continue, but available memory could not be checked.".into();
                    publish(warning);
                }
                save_machine_configuration_with_progress(
                    &SetupRunner {
                        request_id: &request_id,
                        publish: &publish,
                    },
                    &paths,
                    &resources,
                    request,
                    &progress,
                )
            })
            .and_then(|_| read_application_state_with(&ProcessRunner, &paths));
        let mut outcome = machine_progress(
            &request_id,
            if result.is_ok() {
                "setup-completed"
            } else {
                "setup-failed"
            },
            "",
            0,
        );
        if let Err(error) = &result {
            outcome.level = "error".into();
            outcome.failure_code = Some(failure_code(error).into());
            outcome.exit_code = runtime_exit_code(error);
            let last = journal
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .events
                .last()
                .cloned();
            if let Some(last) = last {
                outcome.workspace = last.workspace;
            }
            outcome.message = format!(
                "Sandbox setup failed: {} Check the sandbox state before retrying.",
                safe_activity_error(error)
            );
        }
        publish(outcome);
        result.map_err(|error| safe_activity_error(&error))
    })
    .await
    .map_err(|error| format!("Sandbox configuration worker failed: {error}")).and_then(|result| result);
    if result.is_err() {
        crate::notifications::action_failed(&notify_app, "Sandbox setup failed");
    }
    result
}

fn read_application_state_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
) -> Result<ApplicationSource, RuntimeError> {
    let metadata = read_metadata(&paths.metadata)?;
    let listed = list_managed(runner, paths)?;
    let configured_names: HashSet<&str> = metadata
        .machines
        .iter()
        .filter(|machine| machine.is_vm())
        .map(MachineConfiguration::name)
        .collect();
    let listed_names: HashSet<&str> = listed.iter().map(|entry| entry.name.as_str()).collect();
    if configured_names != listed_names {
        return Err(RuntimeError::Malformed(
            "Silo's saved sandbox configuration does not match its managed runtime state. No sandbox operation was performed.".into(),
        ));
    }

    let mut workspaces = Vec::with_capacity(metadata.machines.len());
    for machine in metadata.machines {
        match &machine {
            MachineConfiguration::Vm { name, .. } => {
                let inspected = inspect_workspace(runner, paths, name)?;
                ensure_managed(&inspected)?;
                workspaces.push(vm_workspace(paths, machine, &inspected));
            }
            MachineConfiguration::Ssh { host, .. } => workspaces.push(ApplicationWorkspace {
                machine: machine.clone(),
                purpose: "SSH sandbox".into(),
                state: WorkspaceState::Stopped,
                state_detail: "Remote status is not connected.".into(),
                attention: Some(WorkspaceAttention {
                    level: AttentionLevel::Warning,
                    message: "Silo has not connected to this SSH sandbox.".into(),
                }),
                freshness: Freshness::Fresh,
                host: host.clone(),
                repositories: Vec::new(),
                files: Vec::new(),
                ports: Vec::new(),
                logs: Vec::new(),
                github_repositories: Vec::new(),
                secret_names: Vec::new(),
            }),
        }
    }
    let startup_workspace_ids = workspaces
        .first()
        .map(|workspace| vec![workspace.machine.id().to_string()])
        .unwrap_or_default();
    Ok(ApplicationSource {
        runtime_repair: None,
        workspaces,
        activities: Vec::new(),
        sandbox_configuration_operation: None,
        repository_push_operations: Vec::new(),
        github: serde_json::json!({"state": "disconnected"}),
        secrets: Vec::new(),
        backup: BackupSummary {
            last_archive: "No backups yet".into(),
            completed_label: String::new(),
            compressed_size: String::new(),
            destination: String::new(),
        },
        preferences: Preferences {
            terminal: "Terminal",
            editor: "Visual Studio Code",
            browser: "Safari",
            terminal_path: None,
            editor_path: None,
            browser_path: None,
            terminal_use_system_default: true,
            editor_use_system_default: true,
            browser_use_system_default: true,
            launch_at_login: true,
            start_workspaces_at_launch: false,
            startup_workspace_ids,
            reduce_motion: false,
        },
    })
}

fn list_managed(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
) -> Result<Vec<ListedSandbox>, RuntimeError> {
    let output = runner.run(
        paths,
        &[
            "list".into(),
            "--label".into(),
            MANAGED_LABEL.into(),
            "--format".into(),
            "json".into(),
        ],
        READ_TIMEOUT,
    )?;
    serde_json::from_str(&output.stdout).map_err(|_| {
        RuntimeError::Malformed("The bundled runtime returned an invalid sandbox list.".into())
    })
}

pub(crate) fn inspect_workspace(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Result<InspectedSandbox, RuntimeError> {
    validate_name(name)?;
    let output = runner.run(
        paths,
        &[
            "inspect".into(),
            name.into(),
            "--format".into(),
            "json".into(),
        ],
        READ_TIMEOUT,
    )?;
    serde_json::from_str(&output.stdout).map_err(|_| {
        RuntimeError::Malformed(format!(
            "The bundled runtime returned invalid state for sandbox '{name}'."
        ))
    })
}

pub(crate) fn ensure_managed(inspected: &InspectedSandbox) -> Result<(), RuntimeError> {
    if inspected.name.is_empty()
        || inspected
            .config
            .pointer("/labels/silo.managed")
            .and_then(Value::as_str)
            != Some("true")
    {
        return Err(RuntimeError::Invalid(format!(
            "Sandbox '{}' is not owned by Silo. No sandbox operation was performed.",
            inspected.name
        )));
    }
    Ok(())
}

fn vm_workspace(
    paths: &RuntimePaths,
    machine: MachineConfiguration,
    inspected: &InspectedSandbox,
) -> ApplicationWorkspace {
    let (state, state_detail, attention) = match inspected.status.as_str() {
        "Running" => (
            WorkspaceState::Running,
            "Running".into(),
            configuration_attention(paths, &machine, inspected),
        ),
        "Starting" => (WorkspaceState::Starting, "Starting".into(), None),
        "Draining" => (WorkspaceState::Starting, "Stopping".into(), None),
        "Created" | "Stopped" => (
            WorkspaceState::Stopped,
            "Stopped".into(),
            configuration_attention(paths, &machine, inspected),
        ),
        "Paused" => (WorkspaceState::Stopped, "Paused".into(), None),
        "Crashed" => (
            WorkspaceState::Failed,
            "The MicroSandbox runtime reported a crash.".into(),
            Some(WorkspaceAttention {
                level: AttentionLevel::Error,
                message: "The sandbox runtime crashed. Restart it to retry.".into(),
            }),
        ),
        other => (
            WorkspaceState::Failed,
            format!("The MicroSandbox runtime reported unknown state '{other}'."),
            Some(WorkspaceAttention {
                level: AttentionLevel::Error,
                message: format!("The sandbox runtime returned unknown state '{other}'."),
            }),
        ),
    };
    ApplicationWorkspace {
        machine,
        purpose: "Local MicroSandbox".into(),
        state,
        state_detail,
        attention,
        freshness: Freshness::Fresh,
        host: "127.0.0.1".into(),
        repositories: Vec::new(),
        files: Vec::new(),
        ports: Vec::new(),
        logs: Vec::new(),
        github_repositories: Vec::new(),
        secret_names: Vec::new(),
    }
}

fn configuration_attention(
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    inspected: &InspectedSandbox,
) -> Option<WorkspaceAttention> {
    let MachineConfiguration::Vm {
        cpus,
        max_cpus,
        memory_gib,
        max_memory_gib,
        runtime_storage_gib,
        ..
    } = machine
    else {
        return None;
    };
    let expected = (
        u64::from(*cpus),
        u64::from(*max_cpus),
        u64::from(*memory_gib) * 1024,
        u64::from(*max_memory_gib) * 1024,
        u64::from(*runtime_storage_gib) * 1024,
    );
    let actual = (
        inspected
            .config
            .pointer("/resources/cpus")
            .and_then(Value::as_u64),
        inspected
            .config
            .pointer("/resources/max_cpus")
            .and_then(Value::as_u64),
        inspected
            .config
            .pointer("/resources/memory_mib")
            .and_then(Value::as_u64),
        inspected
            .config
            .pointer("/resources/max_memory_mib")
            .and_then(Value::as_u64),
        inspected
            .config
            .pointer("/image/Oci/root_disk/size_mib")
            .and_then(Value::as_u64),
    );
    let expected_mounts = [(
        disk_path(paths, machine.name(), "workspace"),
        WORKSPACE_MOUNT,
    )];
    let mounts_match = inspected
        .config
        .get("mounts")
        .and_then(Value::as_array)
        .is_some_and(|mounts| {
            expected_mounts
                .iter()
                .all(|(expected_path, expected_guest)| {
                    mounts.iter().any(|mount| {
                        mount.get("type").and_then(Value::as_str) == Some("DiskImage")
                            && mount.get("host").and_then(Value::as_str) == expected_path.to_str()
                            && mount.get("guest").and_then(Value::as_str) == Some(*expected_guest)
                            && mount.get("format").and_then(Value::as_str) == Some("Raw")
                            && mount.get("fstype").and_then(Value::as_str) == Some("ext4")
                    })
                })
        });
    if mounts_match
        && actual
            == (
                Some(expected.0),
                Some(expected.1),
                Some(expected.2),
                Some(expected.3),
                Some(expected.4),
            )
    {
        None
    } else {
        Some(WorkspaceAttention {
            level: AttentionLevel::Warning,
            message: "Saved Silo resource settings differ from the runtime configuration.".into(),
        })
    }
}

pub(crate) fn start_at_launch(app: &AppHandle, id: &str) -> Result<(), String> {
    let paths = runtime_paths(app)?;
    let _guard = MUTATION_LOCK
        .lock()
        .map_err(|_| RuntimeError::Busy.to_string())?;
    if crate::startup::is_cancelled(app) {
        return Ok(());
    }
    host_resources()
        .and_then(|host| start_at_launch_with(&ProcessRunner, &paths, &host, id))
        .map_err(|error| safe_activity_error(&error))
}

fn start_at_launch_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
    id: &str,
) -> Result<(), RuntimeError> {
    let metadata = read_metadata(&paths.metadata)?;
    let machine = metadata.machines.iter().find(|machine| machine.id() == id)
        .ok_or_else(|| RuntimeError::Invalid("A sandbox selected for launch no longer exists. Update the startup selection in Settings.".into()))?;
    let name = machine.name();
    if !machine.is_vm() {
        return Err(RuntimeError::Invalid(format!(
            "{name} is a remote SSH sandbox. Automatic remote startup is unavailable."
        )));
    }
    let result = (|| {
        let inspected = inspect_workspace(runner, paths, name)?;
        ensure_managed(&inspected)?;
        match inspected.status.to_ascii_lowercase().as_str() {
            "running" => Ok(()),
            "created" | "stopped" => {
                workspace_action_with(runner, paths, host, "start", name)?;
                let started = inspect_workspace(runner, paths, name)?;
                ensure_managed(&started)?;
                if started.status.eq_ignore_ascii_case("running") {
                    Ok(())
                } else {
                    Err(RuntimeError::Invalid(format!(
                        "{name} did not reach the running state. Check its status before retrying."
                    )))
                }
            }
            _ => Err(RuntimeError::Invalid(format!(
                "{name} is not stopped or running. Check its status before starting it."
            ))),
        }
    })();
    result
        .map_err(|error| RuntimeError::Invalid(format!("{name}: {}", safe_activity_error(&error))))
}

fn workspace_action_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
    action: &str,
    name: &str,
) -> Result<(), RuntimeError> {
    validate_name(name)?;
    let metadata = read_metadata(&paths.metadata)?;
    let machine = metadata
        .machines
        .iter()
        .find(|machine| machine.name() == name)
        .ok_or_else(|| {
            RuntimeError::Invalid(format!("Sandbox '{name}' is not configured in Silo."))
        })?;
    if !machine.is_vm() {
        return Err(RuntimeError::Invalid(format!(
            "Sandbox '{name}' is an SSH configuration. Local VM actions are unavailable."
        )));
    }
    let inspected = inspect_workspace(runner, paths, name)?;
    ensure_managed(&inspected)?;
    if matches!(action, "start" | "restart") {
        validate_inspected_resources(name, &inspected.config, host)?;
    }
    let (command, timeout) =
        match action {
            "start" => ("start", MUTATION_TIMEOUT),
            "stop" => ("stop", STOP_TIMEOUT),
            "restart" => ("restart", MUTATION_TIMEOUT),
            "pause" => return Err(RuntimeError::Invalid(
                "Pause is not supported by bundled MicroSandbox 0.6.17. Stop the sandbox instead."
                    .into(),
            )),
            _ => {
                return Err(RuntimeError::Invalid(format!(
                    "Unknown sandbox action '{action}'. No sandbox operation was performed."
                )))
            }
        };
    runner.run(
        paths,
        &[command.into(), name.into(), "--quiet".into()],
        timeout,
    )?;
    Ok(())
}

#[cfg(test)]
fn save_machine_configuration_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
    request: MachineConfigurationRequest,
) -> Result<(), RuntimeError> {
    save_machine_configuration_with_progress(runner, paths, host, request, &|_, _, _| {})
}

fn save_machine_configuration_with_progress(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
    request: MachineConfigurationRequest,
    progress: &dyn Fn(&str, &str, u8),
) -> Result<(), RuntimeError> {
    validate_request(&request)?;
    let previous = read_metadata(&paths.metadata)?;
    validate_requested_resources(&request, host)?;
    let previous_by_id: HashMap<&str, &MachineConfiguration> = previous
        .machines
        .iter()
        .map(|machine| (machine.id(), machine))
        .collect();
    let requested_ids: HashSet<&str> = request
        .machines
        .iter()
        .map(MachineConfiguration::id)
        .collect();

    for machine in &request.machines {
        if let Some(old) = previous_by_id.get(machine.id()) {
            if *old != machine {
                validate_machine_update(old, machine)?;
                if machine.is_vm() {
                    ensure_managed(&inspect_workspace(runner, paths, machine.name())?)?;
                }
            }
        }
    }
    for machine in previous
        .machines
        .iter()
        .filter(|machine| !requested_ids.contains(machine.id()))
    {
        preflight_removal(runner, paths, machine)?;
    }
    let mut applied = previous.clone();
    let mut changed = false;
    let result = (|| {
        for machine in &request.machines {
            match previous_by_id.get(machine.id()) {
                None => {
                    progress("workspace-configuration", machine.name(), 0);
                    create_machine_with_progress(runner, paths, machine, progress)?;
                }
                Some(old) if *old == machine => {
                    if machine.is_vm() {
                        progress("workspace-verification", machine.name(), 0);
                        verify_machine_configuration(runner, paths, machine)?;
                        progress("workspace-verification", machine.name(), 1);
                    }
                    continue;
                }
                Some(old) => {
                    progress("workspace-configuration", machine.name(), 0);
                    update_machine(runner, paths, old, machine)?;
                }
            }
            changed = true;
            applied
                .machines
                .retain(|existing| existing.id() != machine.id());
            applied.machines.push(machine.clone());
            progress("workspace-settings", machine.name(), 0);
            write_metadata(&paths.metadata, &applied)?;
            progress("workspace-configuration", machine.name(), 1);
            if machine.is_vm() {
                progress("workspace-verification", machine.name(), 0);
                verify_machine_configuration(runner, paths, machine)?;
                progress("workspace-verification", machine.name(), 1);
            }
        }
        for machine in previous
            .machines
            .iter()
            .filter(|machine| !requested_ids.contains(machine.id()))
        {
            progress("workspace-removal", machine.name(), 0);
            remove_machine_runtime(runner, paths, machine)?;
            changed = true;
            applied
                .machines
                .retain(|existing| existing.id() != machine.id());
            write_metadata(&paths.metadata, &applied)?;
            remove_machine_volumes(paths, machine)?;
            progress("workspace-removal", machine.name(), 1);
        }
        write_metadata(&paths.metadata, &request)
    })();
    result.map_err(|error| if changed {
        RuntimeError::Failed { operation: "Applying the sandbox configuration".into(), detail: format!("Some sandbox changes were applied before this error: {error} Completed changes were kept; reload the sandbox list before retrying.") }
    } else { error })
}

fn verify_machine_configuration(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    let inspected = inspect_workspace(runner, paths, machine.name())?;
    ensure_managed(&inspected)?;
    if configuration_attention(paths, machine, &inspected).is_some() {
        return Err(RuntimeError::Malformed(format!("Saved runtime resources for '{}' do not match the requested configuration. Setup is not complete.", machine.name())));
    }
    Ok(())
}

fn validate_machine_update(
    previous: &MachineConfiguration,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    if previous.name() != machine.name() {
        return Err(RuntimeError::Invalid(format!("Bundled MicroSandbox cannot rename sandbox '{}'. Keep its name or create a new sandbox.", previous.name())));
    }
    match (previous, machine) {
        (MachineConfiguration::Ssh { .. }, MachineConfiguration::Ssh { .. }) => Ok(()),
        (MachineConfiguration::Vm { workspace_storage_gib: old_workspace, runtime_storage_gib: old_runtime, .. }, MachineConfiguration::Vm { workspace_storage_gib, runtime_storage_gib, .. }) if old_workspace == workspace_storage_gib && old_runtime == runtime_storage_gib => Ok(()),
        (MachineConfiguration::Vm { .. }, MachineConfiguration::Vm { .. }) => Err(RuntimeError::Invalid("Storage disks cannot be resized in place. Keep both saved sizes or create a new sandbox.".into())),
        _ => Err(RuntimeError::Invalid("A sandbox cannot change between a local VM and SSH configuration.".into())),
    }
}

fn configure_guest_tools(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Result<(), RuntimeError> {
    runner.run(
        paths,
        &[
            "exec".into(),
            name.into(),
            "--no-tty".into(),
            "--quiet".into(),
            "--timeout".into(),
            "10m".into(),
            "--user".into(),
            "root".into(),
            "--workdir".into(),
            "/".into(),
            "--".into(),
            "sh".into(),
            "-c".into(),
            include_str!("../guest/setup-github.sh").into(),
        ],
        Duration::from_secs(630),
    )?;
    let inspected = inspect_workspace(runner, paths, name)?;
    ensure_managed(&inspected)?;
    if !matches!(inspected.status.as_str(), "Created" | "Stopped") {
        return Err(RuntimeError::Malformed(
            "The sandbox tools were prepared, but the runtime did not restore its stopped state."
                .into(),
        ));
    }
    Ok(())
}

fn create_machine(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    create_machine_with_progress(runner, paths, machine, &|_, _, _| {})
}

fn create_machine_with_progress(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    progress: &dyn Fn(&str, &str, u8),
) -> Result<(), RuntimeError> {
    let MachineConfiguration::Vm {
        id,
        name,
        cpus,
        max_cpus,
        memory_gib,
        max_memory_gib,
        workspace_storage_gib,
        runtime_storage_gib,
    } = machine
    else {
        return Ok(());
    };
    let workspace_volume = disk_path(paths, name, "workspace");
    progress("workspace-disk-preparation", name, 0);
    create_disk_volume(&workspace_volume, *workspace_storage_gib)?;
    let preflight = (|| {
        let listed = runner.run(
            paths,
            &["list".into(), "--format".into(), "json".into()],
            READ_TIMEOUT,
        )?;
        let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout).map_err(|_| {
            RuntimeError::Malformed(
                "The runtime returned an invalid sandbox list before creation.".into(),
            )
        })?;
        if listed.iter().any(|sandbox| sandbox.name == *name) {
            return Err(RuntimeError::Invalid(format!(
                "Sandbox '{name}' already exists in the runtime. No existing sandbox was changed."
            )));
        }
        let protocol = runner.run(paths, &["--silo-github-protocol".into()], READ_TIMEOUT)?;
        if protocol.stdout.trim() != "1" {
            return Err(RuntimeError::Unavailable(
                "The bundled runtime does not support secure GitHub access. Repair Silo before creating sandboxes.".into(),
            ));
        }
        Ok(())
    })();
    if let Err(error) = preflight {
        return Err(with_cleanup_error(
            error,
            remove_disk_path(&workspace_volume),
        ));
    }
    let args = vec![
        "create".into(),
        DEFAULT_IMAGE.into(),
        "--name".into(),
        name.clone(),
        "--cpus".into(),
        cpus.to_string(),
        "--max-cpus".into(),
        max_cpus.to_string(),
        "--memory".into(),
        format!("{memory_gib}G"),
        "--max-memory".into(),
        format!("{max_memory_gib}G"),
        "--root-disk".into(),
        format!("{runtime_storage_gib}G"),
        "--mount-disk".into(),
        format!(
            "{}:{WORKSPACE_MOUNT}:format=raw,fstype=ext4",
            workspace_volume.display()
        ),
        "--label".into(),
        MANAGED_LABEL.into(),
        "--label".into(),
        format!("silo.machine-id={id}"),
        "--label".into(),
        format!("silo.workspace-storage-gib={workspace_storage_gib}"),
        "--label".into(),
        format!("silo.runtime-storage-gib={runtime_storage_gib}"),
        "--secret".into(),
        "SILO_GITHUB@github.com,api.github.com,uploads.github.com".into(),
        "--env".into(),
        "GH_TOKEN=$MSB_SILO_GITHUB".into(),
        "--label".into(),
        "silo.github-protocol=1".into(),
        "--no-start".into(),
        "--quiet".into(),
        "--progress-json".into(),
    ];
    progress("workspace-runtime-preparation", name, 0);
    if let Err(error) = runner.run(paths, &args, MUTATION_TIMEOUT) {
        return Err(with_cleanup_error(
            error,
            cleanup_failed_create(runner, paths, name, id),
        ));
    }
    let inspected = inspect_workspace(runner, paths, name)?;
    ensure_managed(&inspected)?;
    if !matches!(inspected.status.as_str(), "Created" | "Stopped") {
        return Err(with_cleanup_error(
            RuntimeError::Malformed(format!(
                "Sandbox '{name}' did not remain stopped after creation."
            )),
            cleanup_failed_create(runner, paths, name, id),
        ));
    }
    if let Err(error) = configure_guest_tools(runner, paths, name) {
        return Err(with_cleanup_error(
            error,
            cleanup_failed_create(runner, paths, name, id),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn apply_disposable_test_identity(
    paths: &RuntimePaths,
    name: &str,
) -> Result<(), RuntimeError> {
    configure_workspace_identities_with(
        &ProcessRunner,
        paths,
        &[WorkspaceIdentity {
            workspace: name.into(),
            name: "Silo Test".into(),
            email: "silo-test@example.invalid".into(),
            apply: true,
        }],
    )
}

#[cfg(test)]
pub(crate) fn create_disposable_test_machine(
    paths: &RuntimePaths,
    name: &str,
) -> Result<MachineConfiguration, RuntimeError> {
    let machine = MachineConfiguration::Vm {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        cpus: 1,
        max_cpus: 1,
        memory_gib: 1,
        max_memory_gib: 1,
        workspace_storage_gib: 1,
        runtime_storage_gib: 2,
    };
    let mut request = read_metadata(&paths.metadata)?;
    request.machines.push(machine.clone());
    save_machine_configuration_with(&ProcessRunner, paths, &host_resources()?, request)?;
    Ok(machine)
}

fn cleanup_failed_create(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    machine_id: &str,
) -> Result<(), RuntimeError> {
    let listed = runner.run(
        paths,
        &["list".into(), "--format".into(), "json".into()],
        READ_TIMEOUT,
    )?;
    let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout).map_err(|_| {
        RuntimeError::Malformed(
            "The bundled runtime returned an invalid sandbox list during cleanup.".into(),
        )
    })?;
    if listed.iter().any(|sandbox| sandbox.name == name) {
        let inspected = inspect_workspace(runner, paths, name)?;
        ensure_managed(&inspected)?;
        if inspected
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(machine_id)
        {
            return Err(RuntimeError::Invalid(
                "The runtime sandbox identity changed during creation. Its data was preserved."
                    .into(),
            ));
        }
        runner.run(
            paths,
            &[
                "remove".into(),
                "--force".into(),
                "--quiet".into(),
                name.into(),
            ],
            STOP_TIMEOUT,
        )?;
    }
    remove_disk_path(&disk_path(paths, name, "workspace"))?;
    Ok(())
}

pub(crate) fn disk_path(paths: &RuntimePaths, machine_name: &str, role: &str) -> PathBuf {
    paths.volumes.join(machine_name).join(format!("{role}.raw"))
}

fn create_disk_volume(path: &Path, size_gib: u32) -> Result<(), RuntimeError> {
    if path.exists() {
        return Err(RuntimeError::Invalid(format!(
            "Silo storage already exists at {}. No existing disk was changed.",
            path.display()
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| RuntimeError::Invalid("Silo's managed disk path is invalid.".into()))?;
    fs::create_dir_all(parent).map_err(|error| {
        RuntimeError::Unavailable(format!("Silo could not prepare managed disks: {error}"))
    })?;
    let stage = tempfile::Builder::new()
        .prefix(".disk-stage-")
        .tempdir_in(parent)
        .map_err(|error| {
            RuntimeError::Unavailable(format!("Silo could not stage a managed disk: {error}"))
        })?;
    let staged = stage.path().join("disk.raw");
    let size_bytes = u64::from(size_gib)
        .checked_mul(1024 * 1024 * 1024)
        .ok_or_else(|| RuntimeError::Invalid("The managed disk size is too large.".into()))?;
    microsandbox_image::ext4::format_ext4(
        &staged,
        &microsandbox_image::ext4::Ext4FormatOptions {
            size_bytes,
            ..Default::default()
        },
    )
    .map_err(|error| RuntimeError::Failed {
        operation: "Creating a managed disk".into(),
        detail: error.to_string(),
    })?;
    File::open(&staged)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            RuntimeError::Unavailable(format!("Silo could not save a managed disk: {error}"))
        })?;
    fs::rename(&staged, path).map_err(|error| {
        RuntimeError::Unavailable(format!("Silo could not publish a managed disk: {error}"))
    })?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            RuntimeError::Unavailable(format!("Silo could not publish a managed disk: {error}"))
        })?;
    Ok(())
}

fn remove_disk_path(path: &Path) -> Result<(), RuntimeError> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(RuntimeError::Unavailable(format!(
                "Silo could not remove an incomplete managed disk: {error}"
            )))
        }
    }
    Ok(())
}

fn remove_machine_volumes(
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    let MachineConfiguration::Vm { name, .. } = machine else {
        return Ok(());
    };
    let mut failure = None;
    for role in ["workspace"] {
        if let Err(error) = remove_disk_path(&disk_path(paths, name, role)) {
            failure = Some(match failure {
                None => error,
                Some(previous) => with_cleanup_error(previous, Err(error)),
            });
        }
    }
    failure.map_or(Ok(()), Err)
}

fn with_cleanup_error(original: RuntimeError, cleanup: Result<(), RuntimeError>) -> RuntimeError {
    match cleanup {
        Ok(()) => original,
        Err(cleanup) => RuntimeError::Failed {
            operation: "Applying the sandbox configuration".into(),
            detail: format!("{original} Cleanup also failed: {cleanup}"),
        },
    }
}

fn update_machine(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    previous: &MachineConfiguration,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    validate_machine_update(previous, machine)?;
    if previous.name() != machine.name() {
        return Err(RuntimeError::Invalid(format!(
            "Bundled MicroSandbox 0.6.17 cannot rename persistent sandbox '{}'. Keep its current name or create a new sandbox.",
            previous.name()
        )));
    }
    match (previous, machine) {
        (MachineConfiguration::Ssh { .. }, MachineConfiguration::Ssh { .. }) => Ok(()),
        (
            MachineConfiguration::Vm { name, .. },
            MachineConfiguration::Vm {
                id,
                cpus,
                max_cpus,
                memory_gib,
                max_memory_gib,
                workspace_storage_gib,
                runtime_storage_gib,
                ..
            },
        ) => {
            let MachineConfiguration::Vm {
                workspace_storage_gib: previous_workspace,
                runtime_storage_gib: previous_runtime,
                ..
            } = previous
            else {
                unreachable!()
            };
            if workspace_storage_gib != previous_workspace
                || runtime_storage_gib != previous_runtime
            {
                return Err(RuntimeError::Invalid(format!(
                    "Storage disks for sandbox '{name}' cannot be resized in place. Keep both saved sizes or create a new sandbox. No disk was changed."
                )));
            }
            let inspected = inspect_workspace(runner, paths, name)?;
            ensure_managed(&inspected)?;
            runner.run(
                paths,
                &[
                    "modify".into(),
                    name.clone(),
                    "--cpus".into(),
                    cpus.to_string(),
                    "--max-cpus".into(),
                    max_cpus.to_string(),
                    "--memory".into(),
                    format!("{memory_gib}G"),
                    "--max-memory".into(),
                    format!("{max_memory_gib}G"),
                    "--label".into(),
                    format!("silo.machine-id={id}"),
                    "--label".into(),
                    format!("silo.workspace-storage-gib={workspace_storage_gib}"),
                    "--label".into(),
                    format!("silo.runtime-storage-gib={runtime_storage_gib}"),
                    "--next-start".into(),
                    "--format".into(),
                    "json".into(),
                ],
                MUTATION_TIMEOUT,
            )?;
            Ok(())
        }
        _ => Err(RuntimeError::Invalid(format!(
            "Sandbox '{}' cannot change between a local VM and an SSH configuration.",
            previous.name()
        ))),
    }
}

fn preflight_removal(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    let MachineConfiguration::Vm { name, .. } = machine else {
        return Ok(());
    };
    let inspected = inspect_workspace(runner, paths, name)?;
    ensure_managed(&inspected)?;
    if !matches!(inspected.status.as_str(), "Stopped" | "Created" | "Crashed") {
        return Err(RuntimeError::Invalid(format!(
            "Stop sandbox '{name}' before removing it from Silo. This sandbox was not removed."
        )));
    }
    Ok(())
}

fn remove_machine_runtime(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    let MachineConfiguration::Vm { name, .. } = machine else {
        return Ok(());
    };
    preflight_removal(runner, paths, machine)?;
    runner.run(
        paths,
        &["remove".into(), "--quiet".into(), name.clone()],
        STOP_TIMEOUT,
    )?;
    Ok(())
}

#[cfg(test)]
fn remove_machine(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    remove_machine_runtime(runner, paths, machine)?;
    remove_machine_volumes(paths, machine)
}

fn validate_request(request: &MachineConfigurationRequest) -> Result<(), RuntimeError> {
    if request.schema_version != 1 {
        return Err(RuntimeError::Invalid(
            "The sandbox configuration version is not supported.".into(),
        ));
    }
    if request.machines.is_empty() || request.machines.len() > MAX_MACHINE_COUNT {
        return Err(RuntimeError::Invalid(format!(
            "Configure between 1 and {MAX_MACHINE_COUNT} sandboxes."
        )));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for machine in &request.machines {
        validate_name(machine.name())?;
        if uuid::Uuid::try_parse(machine.id()).is_err() || !ids.insert(machine.id()) {
            return Err(RuntimeError::Invalid(
                "Every sandbox must have a unique valid identifier.".into(),
            ));
        }
        if !names.insert(machine.name().to_ascii_lowercase()) {
            return Err(RuntimeError::Invalid(
                "Sandbox names must be unique.".into(),
            ));
        }
        match machine {
            MachineConfiguration::Vm {
                cpus,
                max_cpus,
                memory_gib,
                max_memory_gib,
                workspace_storage_gib,
                runtime_storage_gib,
                ..
            } => {
                if *cpus == 0 || cpus > max_cpus {
                    return Err(RuntimeError::Invalid(format!(
                        "Sandbox '{}' has an invalid CPU limit or ceiling.",
                        machine.name()
                    )));
                }
                if *memory_gib == 0 || memory_gib > max_memory_gib {
                    return Err(RuntimeError::Invalid(format!(
                        "Sandbox '{}' has an invalid memory limit or ceiling.",
                        machine.name()
                    )));
                }
                let total = workspace_storage_gib
                    .checked_add(*runtime_storage_gib)
                    .and_then(|gib| gib.checked_mul(1024));
                if *workspace_storage_gib == 0 || *runtime_storage_gib == 0 || total.is_none() {
                    return Err(RuntimeError::Invalid(format!(
                        "Sandbox '{}' has an invalid storage allocation.",
                        machine.name()
                    )));
                }
            }
            MachineConfiguration::Ssh { host, user, .. } => {
                if host.trim().is_empty()
                    || host.chars().any(char::is_whitespace)
                    || user.trim().is_empty()
                    || user.chars().any(char::is_whitespace)
                {
                    return Err(RuntimeError::Invalid(format!(
                        "Sandbox '{}' has an invalid SSH host or user.",
                        machine.name()
                    )));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_name(name: &str) -> Result<(), RuntimeError> {
    let mut characters = name.chars();
    let valid = name.len() <= 32
        && characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if valid {
        Ok(())
    } else {
        Err(RuntimeError::Invalid(format!(
            "Sandbox name '{name}' must start with a lowercase letter and contain at most 32 lowercase letters, numbers, or hyphens."
        )))
    }
}

pub(crate) fn read_metadata(path: &Path) -> Result<MachineConfigurationRequest, RuntimeError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MachineConfigurationRequest {
                schema_version: 1,
                machines: Vec::new(),
            })
        }
        Err(error) => {
            return Err(RuntimeError::Unavailable(format!(
                "Silo could not read its sandbox configuration: {error}"
            )))
        }
    };
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(RuntimeError::Malformed(
            "Silo's sandbox configuration is too large.".into(),
        ));
    }
    let request: MachineConfigurationRequest = serde_json::from_slice(&bytes).map_err(|_| {
        RuntimeError::Malformed("Silo's saved sandbox configuration is invalid.".into())
    })?;
    validate_request(&request)?;
    Ok(request)
}

pub(crate) fn write_metadata(
    path: &Path,
    request: &MachineConfigurationRequest,
) -> Result<(), RuntimeError> {
    let parent = path.parent().ok_or_else(|| {
        RuntimeError::Unavailable("Silo's sandbox storage path is invalid.".into())
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        RuntimeError::Unavailable(format!(
            "Silo could not prepare its sandbox settings: {error}"
        ))
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| {
        RuntimeError::Unavailable(format!(
            "Silo could not stage its sandbox settings: {error}"
        ))
    })?;
    let mut bytes = serde_json::to_vec_pretty(request).map_err(|_| {
        RuntimeError::Malformed("Silo could not encode its sandbox settings.".into())
    })?;
    bytes.push(b'\n');
    temporary.write_all(&bytes).map_err(|error| {
        RuntimeError::Unavailable(format!("Silo could not save its sandbox settings: {error}"))
    })?;
    temporary.as_file().sync_all().map_err(|error| {
        RuntimeError::Unavailable(format!("Silo could not save its sandbox settings: {error}"))
    })?;
    temporary.persist(path).map_err(|error| {
        RuntimeError::Unavailable(format!(
            "Silo could not finalize its sandbox settings: {}",
            error.error
        ))
    })?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            RuntimeError::Unavailable(format!(
                "Silo could not finalize its sandbox settings: {error}"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubRunner {
        outputs: Mutex<VecDeque<Result<CommandOutput, RuntimeError>>>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl StubRunner {
        fn new(outputs: Vec<Result<CommandOutput, RuntimeError>>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn successful_json(values: Vec<Value>) -> Self {
            Self::new(
                values
                    .into_iter()
                    .map(|value| {
                        Ok(CommandOutput {
                            stdout: value.to_string(),
                            stderr: String::new(),
                        })
                    })
                    .collect(),
            )
        }
    }

    impl RuntimeRunner for StubRunner {
        fn run(
            &self,
            _paths: &RuntimePaths,
            args: &[String],
            _timeout: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            self.calls.lock().unwrap().push(args.to_vec());
            self.outputs
                .lock()
                .unwrap()
                .pop_front()
                .expect("missing stub output")
        }
    }

    #[test]
    fn github_revisions_reject_delayed_updates_but_allow_same_revision_completion() {
        let mut revision = 4;
        assert!(accept_github_revision(&mut revision, 5).is_ok());
        assert!(accept_github_revision(&mut revision, 4).is_err());
        assert_eq!(revision, 5);
        assert!(accept_github_revision(&mut revision, 5).is_ok());
    }

    #[test]
    fn github_updates_are_independent_of_other_vms_and_lifecycle_operations() {
        let home = tempfile::tempdir().unwrap();
        let a = github_revision_lock(home.path(), "a").unwrap();
        let same = github_revision_lock(home.path(), "a").unwrap();
        let b = github_revision_lock(home.path(), "b").unwrap();
        let _first = a.lock().unwrap();
        let _lifecycle = MUTATION_LOCK.lock().unwrap();
        assert!(same.try_lock().is_err());
        assert!(b.try_lock().is_ok());
    }

    #[test]
    fn github_environment_is_bound_to_runtime_home_and_explicit_command_target() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let paths = paths(&first);
        let other = super::tests::paths(&second);
        let cache = GITHUB_PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
        cache
            .lock()
            .unwrap()
            .insert((paths.home.clone(), "exec".into()), "profile-a".into());
        cache
            .lock()
            .unwrap()
            .insert((paths.home.clone(), "dev".into()), "profile-b".into());
        let args = vec!["start".into(), "dev".into()];
        assert_eq!(github_environment(&paths, &args), "profile-b");
        assert_eq!(github_environment(&other, &args), DISABLED_GITHUB_PROFILE);
        // An exec that races a stop must never implicitly boot with a captured
        // old token. Explicit boot preparation above owns credential injection.
        assert_eq!(
            github_environment(&paths, &["exec".into(), "dev".into()]),
            DISABLED_GITHUB_PROFILE
        );
        assert_eq!(
            github_environment(&paths, &["list".into(), "dev".into()]),
            DISABLED_GITHUB_PROFILE
        );
        assert_eq!(
            github_environment(&paths, &["create".into(), "dev".into()]),
            DISABLED_GITHUB_PROFILE
        );
        cache
            .lock()
            .unwrap()
            .retain(|(home, _), _| home != &paths.home);
    }

    #[test]
    fn production_lifecycle_actions_use_the_target_vms_github_profile() {
        let directory = tempfile::tempdir().unwrap();
        let other_directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let other = super::tests::paths(&other_directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let cache = GITHUB_PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
        cache
            .lock()
            .unwrap()
            .insert((paths.home.clone(), "dev".into()), "dev-profile".into());
        cache
            .lock()
            .unwrap()
            .insert((paths.home.clone(), "other".into()), "other-profile".into());
        for action in ["start", "restart"] {
            let runner = StubRunner::successful_json(vec![inspect(&paths, "Stopped"), json!(null)]);
            workspace_action_with(&runner, &paths, &generous_host(), action, "dev").unwrap();
            let calls = runner.calls.lock().unwrap();
            let command = &calls[1];
            assert_eq!(github_command_workspace(command), Some("dev"));
            assert_eq!(github_environment(&paths, command), "dev-profile");
            assert_eq!(github_environment(&other, command), DISABLED_GITHUB_PROFILE);
        }
        cache
            .lock()
            .unwrap()
            .retain(|(home, _), _| home != &paths.home);
    }

    #[test]
    fn activity_history_survives_restart_and_marks_only_unfinished_attempts_interrupted() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut journal = ActivityJournal::start(&paths, "attempt-1").unwrap();
        journal.append(machine_progress("attempt-1", "setup-started", "", 0));
        journal.append(machine_progress(
            "attempt-1",
            "workspace-verification",
            "dev",
            0,
        ));
        assert_eq!(read_activity(&paths, false).unwrap().len(), 2);
        let recovered = read_activity(&paths, true).unwrap();
        assert_eq!(recovered.last().unwrap().step, "setup-interrupted");
        assert_eq!(recovered.last().unwrap().level, "warning");
        assert_eq!(recovered.last().unwrap().workspace, "dev");
        assert!(recovered.last().unwrap().fraction.is_none());
        assert_eq!(read_activity(&paths, true).unwrap().len(), 3);
        let mut journal = ActivityJournal::start(&paths, "attempt-2").unwrap();
        journal.append(machine_progress("attempt-2", "setup-started", "", 0));
        journal.append(machine_progress("attempt-2", "setup-completed", "", 0));
        let completed = read_activity(&paths, true).unwrap();
        assert_eq!(completed.len(), 2);
        assert_eq!(completed.last().unwrap().step, "setup-completed");
    }

    #[test]
    fn activity_does_not_publish_private_runtime_error_details() {
        let error = RuntimeError::Failed { operation: "Creating the sandbox".into(), detail: "error sending request https://user:SECRET@registry.test/image?token=SECRET /Users/alice/private".into() };
        let safe = safe_activity_error(&error);
        assert!(safe.contains("registry could not be reached"));
        for private in ["SECRET", "alice", "registry.test", "token"] {
            assert!(!safe.contains(private));
        }
    }

    #[test]
    fn activity_reports_history_write_failure_without_losing_the_operation() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = ActivityJournal::start(&paths(&directory), "attempt").unwrap();
        journal.path = directory.path().join("missing-parent/file/activity.json");
        fs::write(directory.path().join("missing-parent"), "blocked").unwrap();
        let event = journal.append(machine_progress(
            "attempt",
            "workspace-verification",
            "dev",
            1,
        ));
        assert_eq!(event.fraction, Some(1));
        assert_eq!(
            journal.events.last().unwrap().step,
            "activity-storage-warning"
        );
        assert!(journal.events.iter().any(|event| event.fraction == Some(1)));
    }

    #[test]
    fn structured_progress_is_drained_on_exit_and_ignores_untrusted_text() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        fs::write(&paths.library, "test").unwrap();
        fs::write(&paths.executable, "#!/bin/sh\nprintf '%s\\n' 'private token=SECRET' '{\"type\":\"silo-progress\",\"phase\":\"image-download\",\"layerIndex\":0,\"downloadedBytes\":7,\"totalBytes\":9}' '{\"type\":\"silo-progress\",\"phase\":\"image-ready\"}' >&2\n").unwrap();
        fs::set_permissions(&paths.executable, fs::Permissions::from_mode(0o700)).unwrap();
        let events = Mutex::new(Vec::new());
        let publish = |event| events.lock().unwrap().push(event);
        SetupRunner {
            request_id: "attempt",
            publish: &publish,
        }
        .run(
            &paths,
            &[
                "create".into(),
                "--name".into(),
                "dev".into(),
                "--progress-json".into(),
            ],
            Duration::from_secs(2),
        )
        .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].downloaded_bytes, Some(7));
        assert_eq!(events[1].step, "image-ready");
        assert!(events.iter().all(|event| !event.message.contains("SECRET")));
    }

    #[test]
    fn activity_preserves_safe_failure_categories_and_rejects_modified_history() {
        for (detail, expected) in [
            ("401 Unauthorized SECRET", "authentication"),
            ("403 forbidden SECRET", "denied access"),
            ("digest mismatch SECRET", "integrity check"),
            ("no space left SECRET", "free disk space"),
        ] {
            let safe = safe_activity_error(&RuntimeError::Failed {
                operation: "Creating the sandbox".into(),
                detail: detail.into(),
            });
            assert!(safe.contains(expected));
            assert!(!safe.contains("SECRET"));
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut journal = ActivityJournal::start(&paths, "attempt").unwrap();
        let mut event = machine_progress("attempt", "setup-completed", "", 0);
        event.message = "SECRET arbitrary persisted text".into();
        journal.append(event);
        assert_eq!(
            read_activity(&paths, true).unwrap()[0].message,
            "Sandbox setup completed."
        );
        journal.events[0].workspace = "https://SECRET".into();
        journal.persist().unwrap();
        assert!(read_activity(&paths, true).is_err());
    }

    #[test]
    fn failed_activity_keeps_typed_reason_and_exit_code_across_restart() {
        let cases = [
            (
                RuntimeError::Failed {
                    operation: "Creating the sandbox".into(),
                    detail: "exit code 17: 401 unauthorized SECRET".into(),
                },
                "auth",
                "authentication",
                Some(17),
            ),
            (
                RuntimeError::Failed {
                    operation: "Creating the sandbox".into(),
                    detail: "exit code 13: Permission denied /private/SECRET".into(),
                },
                "permission",
                "Permission was denied",
                Some(13),
            ),
            (
                RuntimeError::Invalid("Sandbox dev has an invalid CPU limit or ceiling.".into()),
                "resources",
                "CPU, memory, or storage",
                None,
            ),
            (
                RuntimeError::Failed {
                    operation: "Creating the sandbox".into(),
                    detail: "exit code 29: unexpected SECRET".into(),
                },
                "runtime",
                "did not complete",
                Some(29),
            ),
        ];
        for (error, code, message, exit_code) in cases {
            let directory = tempfile::tempdir().unwrap();
            let paths = paths(&directory);
            let mut journal = ActivityJournal::start(&paths, "attempt").unwrap();
            let mut event = machine_progress("attempt", "setup-failed", "dev", 0);
            event.failure_code = Some(failure_code(&error).into());
            event.exit_code = runtime_exit_code(&error);
            event.level = "error".into();
            event.message = "untrusted SECRET must never be shown".into();
            journal.append(event);
            let recovered = read_activity(&paths, true).unwrap();
            let event = recovered.last().unwrap();
            assert_eq!(event.failure_code.as_deref(), Some(code));
            assert_eq!(event.exit_code, exit_code);
            assert!(event.message.contains(message));
            assert!(!event.message.contains("SECRET"));
            if let Some(code) = exit_code {
                assert!(event.message.contains(&format!("exit code {code}")));
            }
        }
    }

    #[test]
    fn interruption_recovery_keeps_a_full_journal_within_its_bound() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut journal = ActivityJournal::start(&paths, "attempt").unwrap();
        journal.events = (0..512)
            .map(|_| machine_progress("attempt", "workspace-verification", "dev", 0))
            .collect();
        journal.persist().unwrap();
        assert_eq!(read_activity(&paths, true).unwrap().len(), 512);
        assert_eq!(read_activity(&paths, true).unwrap().len(), 512);
    }

    #[test]
    fn structured_byte_counts_cannot_change_runtime_error_classification() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        fs::write(&paths.library, "test").unwrap();
        fs::write(&paths.executable, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"silo-progress\",\"phase\":\"image-download\",\"layerIndex\":0,\"downloadedBytes\":40123,\"totalBytes\":40399}' 'DNS lookup failed' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&paths.executable, fs::Permissions::from_mode(0o700)).unwrap();
        let error = run_msb(
            &paths,
            &["create".into(), "--progress-json".into()],
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert_eq!(failure_code(&error), "network");
        assert!(safe_activity_error(&error).contains("could not be reached"));
        assert!(!error.to_string().contains("40123"));
        for detail in [
            "DNS failure for item40123",
            "downloaded 40399 bytes then DNS failure",
        ] {
            assert_eq!(
                failure_code(&RuntimeError::Failed {
                    operation: "Creating".into(),
                    detail: detail.into()
                }),
                "network"
            );
        }
        assert!(mentions_http_status("http status: 401", "401"));
        assert!(mentions_http_status("status code 403", "403"));
        assert!(!mentions_http_status("http 40123", "401"));
    }

    #[test]
    fn activity_contract_matches_frontend_fixture() {
        let mut started = machine_progress("attempt-1", "setup-started", "", 0);
        started.timestamp = 1_700_000_000_000;
        let mut completed = machine_progress("attempt-1", "setup-completed", "", 0);
        completed.timestamp = 1_700_000_001_000;
        completed.elapsed_seconds = 1;
        let mut failed = machine_progress("attempt-2", "setup-failed", "dev", 0);
        failed.timestamp = 1_700_000_002_000;
        failed.elapsed_seconds = 2;
        failed.level = "error".into();
        failed.failure_code = Some("permission".into());
        failed.exit_code = Some(13);
        failed.message = failure_message("permission", Some(13)).unwrap();
        let events = vec![started, completed, failed];
        let fixture: Value =
            serde_json::from_str(include_str!("../../src/test/contracts/setup-activity.json"))
                .unwrap();
        assert_eq!(serde_json::to_value(events).unwrap(), fixture);
    }

    fn paths(directory: &tempfile::TempDir) -> RuntimePaths {
        RuntimePaths {
            storage_home: None,
            executable: directory.path().join("msb"),
            home: directory.path().join("home"),
            library: directory.path().join("libkrunfw"),
            metadata: directory.path().join("machines.json"),
            volumes: directory.path().join("volumes"),
        }
    }

    fn vm() -> MachineConfiguration {
        MachineConfiguration::Vm {
            id: "00000000-0000-4000-8000-000000000001".into(),
            name: "dev".into(),
            cpus: 4,
            max_cpus: 6,
            memory_gib: 16,
            max_memory_gib: 32,
            workspace_storage_gib: 60,
            runtime_storage_gib: 80,
        }
    }

    fn request(machines: Vec<MachineConfiguration>) -> MachineConfigurationRequest {
        MachineConfigurationRequest {
            schema_version: 1,
            machines,
        }
    }

    fn generous_host() -> HostResources {
        HostResources {
            logical_cpus: 64,
            physical_memory_bytes: Some(256 * 1024 * 1024 * 1024),
        }
    }

    fn inspect(paths: &RuntimePaths, status: &str) -> Value {
        let workspace = disk_path(paths, "dev", "workspace");
        json!({
            "name": "dev",
            "status": status,
            "config": {
                "name": "dev",
                "image": {"Oci": {"reference": "ubuntu", "root_disk": {"kind": "managed", "size_mib": 81920}}},
                "resources": {"cpus": 4, "max_cpus": 6, "memory_mib": 16384, "max_memory_mib": 32768},
                "labels": {"silo.managed": "true"},
                "mounts": [
                    {"type":"DiskImage","host":workspace,"guest":"/workspace","format":"Raw","fstype":"ext4"}
                ]
            },
            "active_config": null,
            "pending_changes": []
        })
    }

    #[test]
    fn read_uses_only_managed_runtime_state_and_exact_saved_resources() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let runner = StubRunner::successful_json(vec![
            json!([{"name":"dev","status":"Running","image":"ubuntu"}]),
            inspect(&paths, "Running"),
        ]);

        let state = read_application_state_with(&runner, &paths).unwrap();
        let encoded = serde_json::to_value(state).unwrap();
        assert_eq!(encoded["workspaces"][0]["state"], "running");
        assert_eq!(encoded["workspaces"][0]["machine"]["memoryGiB"], 16);
        assert_eq!(
            encoded["workspaces"][0]["machine"]["workspaceStorageGiB"],
            60
        );
        assert!(encoded["workspaces"][0].get("attention").is_none());
        assert_eq!(
            runner.calls.lock().unwrap()[0],
            vec!["list", "--label", MANAGED_LABEL, "--format", "json"]
        );
    }

    #[test]
    fn read_refuses_missing_runtime_rows_instead_of_publishing_false_success() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let runner = StubRunner::successful_json(vec![json!([])]);

        let error = read_application_state_with(&runner, &paths).unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }

    #[cfg(unix)]
    #[test]
    fn managed_disk_capacity_does_not_reserve_its_logical_size() {
        use std::os::unix::fs::MetadataExt;
        let directory = tempfile::tempdir().unwrap();
        let disk = directory.path().join("workspace.raw");
        create_disk_volume(&disk, 220).unwrap();
        let metadata = fs::metadata(&disk).unwrap();
        assert_eq!(metadata.len(), 220 * 1024 * 1024 * 1024);
        assert!(metadata.blocks() * 512 < metadata.len() / 100);
    }

    #[test]
    fn create_keeps_workspace_and_runtime_on_independent_app_owned_disks() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let runner = StubRunner::successful_json(vec![
            json!([]),
            json!(1),
            json!(null),
            inspect(&paths, "Created"),
            json!(null),
            inspect(&paths, "Stopped"),
        ]);

        create_machine(&runner, &paths, &vm()).unwrap();

        let calls = runner.calls.lock().unwrap();
        assert_eq!(&calls[2][..2], ["create", DEFAULT_IMAGE]);
        assert!(calls[2]
            .windows(2)
            .any(|pair| pair == ["--root-disk", "80G"]));
        let workspace = disk_path(&paths, "dev", "workspace");
        assert_eq!(
            fs::metadata(&workspace).unwrap().len(),
            60 * 1024 * 1024 * 1024
        );
        assert!(!disk_path(&paths, "dev", "runtime").exists());
        assert!(calls[2].windows(2).any(|pair| {
            pair[0] == "--mount-disk"
                && pair[1]
                    == format!(
                        "{}:{WORKSPACE_MOUNT}:format=raw,fstype=ext4",
                        workspace.display()
                    )
        }));
        assert_eq!(
            calls[2].iter().filter(|arg| *arg == "--mount-disk").count(),
            1
        );
        assert!(calls[2]
            .windows(2)
            .any(|pair| pair == ["--label", MANAGED_LABEL]));
    }

    #[test]
    fn guest_tool_setup_does_not_hide_failure_to_restore_stopped_state() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let runner = StubRunner::successful_json(vec![json!(null), inspect(&paths, "Running")]);
        assert!(configure_guest_tools(&runner, &paths, "dev")
            .unwrap_err()
            .to_string()
            .contains("stopped state"));
    }

    #[test]
    fn create_rejects_runtime_without_secure_github_protocol_before_provisioning() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let runner = StubRunner::successful_json(vec![json!([]), json!(0)]);
        let error = create_machine(&runner, &paths, &vm()).unwrap_err();
        assert!(error.to_string().contains("secure GitHub access"));
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| args[0] == "create"));
        assert!(!disk_path(&paths, "dev", "workspace").exists());
    }

    #[test]
    fn create_rejects_unexpected_running_state() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let runner = StubRunner::successful_json(vec![
            json!([]),
            json!(1),
            json!(null),
            inspect(&paths, "Running"),
            json!([]),
        ]);
        let error = create_machine(&runner, &paths, &vm()).unwrap_err();
        assert!(error.to_string().contains("did not remain stopped"));
        assert!(runner.calls.lock().unwrap()[2]
            .iter()
            .any(|arg| arg == "--no-start"));
    }

    #[test]
    fn create_preserves_a_runtime_name_collision() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let runner = StubRunner::successful_json(vec![json!([{"name":"dev"}])]);
        assert!(create_machine(&runner, &paths, &vm()).is_err());
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
        assert!(!disk_path(&paths, "dev", "workspace").exists());
    }

    #[test]
    fn create_never_replaces_a_preexisting_owned_disk_path() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let workspace = disk_path(&paths, "dev", "workspace");
        fs::create_dir_all(workspace.parent().unwrap()).unwrap();
        fs::write(&workspace, b"existing-user-data").unwrap();
        let runner = StubRunner::new(Vec::new());

        let error = create_machine(&runner, &paths, &vm()).unwrap_err();

        assert!(error.to_string().contains("already exists"));
        assert_eq!(fs::read(workspace).unwrap(), b"existing-user-data");
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn update_rejects_storage_resize_before_any_runtime_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let previous = vm();
        let mut changed = previous.clone();
        if let MachineConfiguration::Vm {
            workspace_storage_gib,
            runtime_storage_gib,
            ..
        } = &mut changed
        {
            *workspace_storage_gib += 1;
            *runtime_storage_gib += 2;
        }
        let runner = StubRunner::new(Vec::new());

        let error = update_machine(&runner, &paths, &previous, &changed).unwrap_err();

        assert!(error.to_string().contains("cannot be resized in place"));
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn launch_starts_selected_existing_vm_and_verifies_running() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        for initial_status in ["Created", "Stopped"] {
            let runner = StubRunner::successful_json(vec![
                inspect(&paths, initial_status),
                inspect(&paths, initial_status),
                json!(null),
                inspect(&paths, "Running"),
            ]);
            start_at_launch_with(&runner, &paths, &generous_host(), vm().id()).unwrap();
            let calls = runner.calls.lock().unwrap();
            assert_eq!(calls[2], vec!["start", "dev", "--quiet"]);
            assert_eq!(calls[3], vec!["inspect", "dev", "--format", "json"]);
            assert!(!calls.iter().any(|call| call[0] == "create"));
        }
    }

    #[test]
    fn launch_skips_running_and_rejects_missing_ssh_and_unready() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &request(vec![
                vm(),
                MachineConfiguration::Ssh {
                    id: "00000000-0000-4000-8000-000000000002".into(),
                    name: "remote".into(),
                    host: "example.test".into(),
                    user: "user".into(),
                    port: 22,
                },
            ]),
        )
        .unwrap();
        let runner = StubRunner::successful_json(vec![inspect(&paths, "Running")]);
        start_at_launch_with(&runner, &paths, &generous_host(), vm().id()).unwrap();
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
        assert!(start_at_launch_with(&runner, &paths, &generous_host(), "deleted").is_err());
        assert!(start_at_launch_with(
            &runner,
            &paths,
            &generous_host(),
            "00000000-0000-4000-8000-000000000002"
        )
        .is_err());
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
        let runner = StubRunner::successful_json(vec![
            inspect(&paths, "Stopped"),
            inspect(&paths, "Stopped"),
            json!(null),
            inspect(&paths, "Stopped"),
        ]);
        assert!(
            start_at_launch_with(&runner, &paths, &generous_host(), vm().id())
                .unwrap_err()
                .to_string()
                .contains("did not reach")
        );
    }

    #[test]
    fn launch_does_not_recover_crashed_or_transitioning_vms() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        for status in ["Crashed", "Starting", "Draining", "Paused"] {
            let runner = StubRunner::successful_json(vec![inspect(&paths, status)]);
            assert!(start_at_launch_with(&runner, &paths, &generous_host(), vm().id()).is_err());
            assert_eq!(runner.calls.lock().unwrap().len(), 1);
        }
    }

    #[test]
    fn launch_respects_resources_and_ownership_without_starting() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let mut unowned = inspect(&paths, "Stopped");
        unowned["config"]["labels"] = json!({});
        let runner = StubRunner::successful_json(vec![unowned]);
        assert!(start_at_launch_with(&runner, &paths, &generous_host(), vm().id()).is_err());
        let runner = StubRunner::successful_json(vec![
            inspect(&paths, "Stopped"),
            inspect(&paths, "Stopped"),
        ]);
        let host = HostResources {
            logical_cpus: 1,
            physical_memory_bytes: Some(1024),
        };
        assert!(start_at_launch_with(&runner, &paths, &host, vm().id()).is_err());
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call[0] == "start"));
    }

    #[test]
    fn lifecycle_checks_metadata_and_runtime_ownership_before_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let runner = StubRunner::successful_json(vec![inspect(&paths, "Stopped"), json!(null)]);

        workspace_action_with(&runner, &paths, &generous_host(), "start", "dev").unwrap();

        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls[0], vec!["inspect", "dev", "--format", "json"]);
        assert_eq!(calls[1], vec!["start", "dev", "--quiet"]);
    }

    #[test]
    fn lifecycle_refuses_a_runtime_row_without_silo_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let mut unowned = inspect(&paths, "Stopped");
        unowned["config"]["labels"] = json!({});
        let runner = StubRunner::successful_json(vec![unowned]);

        let error =
            workspace_action_with(&runner, &paths, &generous_host(), "start", "dev").unwrap_err();
        assert!(error.to_string().contains("not owned by Silo"));
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn validation_rejects_duplicates_and_invalid_resource_order() {
        let mut duplicate = vm();
        if let MachineConfiguration::Vm { name, .. } = &mut duplicate {
            *name = "dev".into();
        }
        assert!(validate_request(&request(vec![vm(), duplicate])).is_err());

        let mut invalid = vm();
        if let MachineConfiguration::Vm { cpus, max_cpus, .. } = &mut invalid {
            *cpus = 8;
            *max_cpus = 4;
        }
        assert!(validate_request(&request(vec![invalid])).is_err());
    }

    #[test]
    fn saved_configuration_is_available_without_runtime_files() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let expected = request(vec![vm()]);
        write_metadata(&paths.metadata, &expected).unwrap();

        assert_eq!(read_metadata(&paths.metadata).unwrap(), expected);
        assert!(!paths.executable.exists());
        assert!(!paths.home.exists());
        assert!(!paths.library.exists());
    }

    #[test]
    fn saved_configuration_distinguishes_first_launch_from_invalid_data() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("machines.json");
        assert!(read_metadata(&path).unwrap().machines.is_empty());

        fs::write(&path, b"not json").unwrap();
        assert!(read_metadata(&path).is_err());
        fs::write(&path, br#"{"schemaVersion":1,"machines":[]}"#).unwrap();
        assert!(read_metadata(&path).is_err());
    }

    #[test]
    fn metadata_round_trip_is_atomic_and_preserves_split_storage_settings() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let expected = request(vec![vm()]);

        write_metadata(&paths.metadata, &expected).unwrap();

        assert_eq!(read_metadata(&paths.metadata).unwrap(), expected);
    }

    #[test]
    fn measured_resources_reject_impossible_cpu_and_memory_requests() {
        let request = request(vec![vm()]);
        let constrained_cpu = HostResources {
            logical_cpus: 4,
            physical_memory_bytes: Some(256 * 1024 * 1024 * 1024),
        };
        assert!(validate_requested_resources(&request, &constrained_cpu)
            .unwrap_err()
            .to_string()
            .contains("reports 4 logical CPUs"));

        let constrained_memory = HostResources {
            logical_cpus: 64,
            physical_memory_bytes: Some(31 * 1024 * 1024 * 1024),
        };
        assert!(validate_requested_resources(&request, &constrained_memory)
            .unwrap_err()
            .to_string()
            .contains("reports 31 GiB"));
    }

    #[test]
    fn removal_cleans_workspace_only_after_runtime_removal_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let disk = disk_path(&paths, "dev", "workspace");
        fs::create_dir_all(disk.parent().unwrap()).unwrap();
        fs::write(&disk, b"workspace-data").unwrap();
        let failed = StubRunner::new(vec![
            Ok(CommandOutput {
                stdout: inspect(&paths, "Stopped").to_string(),
                stderr: String::new(),
            }),
            Err(RuntimeError::Unavailable("runtime removal failed".into())),
        ]);
        assert!(remove_machine(&failed, &paths, &vm()).is_err());
        assert_eq!(fs::read(&disk).unwrap(), b"workspace-data");
        let successful = StubRunner::successful_json(vec![inspect(&paths, "Stopped"), json!(null)]);
        remove_machine(&successful, &paths, &vm()).unwrap();
        assert!(!disk.exists());
    }

    fn test_identity() -> WorkspaceIdentity {
        WorkspaceIdentity {
            workspace: "dev".into(),
            name: "Test User".into(),
            email: "test@example.com".into(),
            apply: true,
        }
    }

    fn identity_output(value: &str) -> Result<CommandOutput, RuntimeError> {
        Ok(CommandOutput {
            stdout: value.into(),
            stderr: String::new(),
        })
    }

    #[test]
    fn identity_resume_verifies_guest_files_not_boot_environment() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let runner = StubRunner::new(vec![
            identity_output(&inspect(&paths, "Running").to_string()),
            identity_output("silo-identity-verified"),
        ]);
        assert!(verify_workspace_identities_with(&runner, &paths, &[test_identity()]).unwrap());
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls[1][0], "exec");
        assert!(!calls.iter().any(|args| args[0] == "modify"));
    }

    #[test]
    fn running_identity_change_uses_normal_config_without_restart() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let mut identity = test_identity();
        identity.name = "O'Neil $(touch /tmp/unsafe)".into();
        let runner = StubRunner::new(vec![
            identity_output(&inspect(&paths, "Running").to_string()),
            identity_output("{}"),
            identity_output(""),
            identity_output("silo-identity-verified"),
        ]);
        configure_workspace_identities_with(&runner, &paths, &[identity]).unwrap();
        let calls = runner.calls.lock().unwrap();
        assert!(calls[1].iter().any(|arg| arg == "--env-rm"));
        assert_eq!(calls[2][0], "exec");
        assert!(calls[2]
            .iter()
            .any(|arg| arg == "O'Neil $(touch /tmp/unsafe)"));
        assert!(!calls
            .iter()
            .any(|args| ["restart", "stop", "start"].contains(&args[0].as_str())));
    }

    #[test]
    fn identity_missing_or_failed_guest_verification_never_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &request(vec![vm()])).unwrap();
        let runner = StubRunner::new(vec![
            identity_output(&inspect(&paths, "Running").to_string()),
            identity_output(""),
        ]);
        assert!(!verify_workspace_identities_with(&runner, &paths, &[test_identity()]).unwrap());
        let failed = StubRunner::new(vec![
            identity_output(&inspect(&paths, "Running").to_string()),
            Err(RuntimeError::Unavailable("guest unavailable".into())),
        ]);
        assert!(verify_workspace_identities_with(&failed, &paths, &[test_identity()]).is_err());
    }

    #[test]
    fn unapplied_identity_does_not_modify_vm() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let runner = StubRunner::new(vec![]);
        configure_workspace_identities_with(
            &runner,
            &paths,
            &[WorkspaceIdentity {
                workspace: "dev".into(),
                name: String::new(),
                email: String::new(),
                apply: false,
            }],
        )
        .unwrap();
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn unknown_and_overflowing_resource_checks_never_pass() {
        let unknown = HostResources {
            logical_cpus: 8,
            physical_memory_bytes: None,
        };
        assert!(validate_host_ceiling("dev", 1, 1, &unknown).is_err());
        assert!(validate_host_ceiling("dev", 0, 1, &generous_host()).is_err());
        assert!(validate_inspected_resources(
            "dev",
            &json!({"resources": {"max_cpus": 1, "max_memory_mib": u64::MAX}}),
            &generous_host()
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runtime_alias_is_short_and_preserves_existing_storage() {
        let directory = tempfile::Builder::new()
            .prefix("silo")
            .tempdir_in("/tmp")
            .unwrap();
        let storage = directory
            .path()
            .join("long-application-support-path/runtime/microsandbox");
        fs::create_dir_all(&storage).unwrap();
        fs::write(storage.join("existing-vm-data"), b"preserved").unwrap();
        let alias = runtime_home_alias(directory.path(), &storage);
        prepare_runtime_home(&alias, Some(&storage)).unwrap();
        assert_eq!(fs::read_link(&alias).unwrap(), storage);
        let socket = alias.join("run/sandboxes/000000000000000000000000/control.sock");
        fs::create_dir_all(socket.parent().unwrap()).unwrap();
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        assert_eq!(
            fs::read(alias.join("existing-vm-data")).unwrap(),
            b"preserved"
        );
        assert!(
            alias
                .join("run/sandboxes/000000000000000000000000/control.sock")
                .as_os_str()
                .as_encoded_bytes()
                .len()
                <= 103
        );
        assert_eq!(
            fs::read(storage.join("existing-vm-data")).unwrap(),
            b"preserved"
        );
        prepare_runtime_home(&alias, Some(&storage)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn runtime_alias_never_replaces_an_existing_wrong_target() {
        let directory = tempfile::Builder::new()
            .prefix("silo")
            .tempdir_in("/tmp")
            .unwrap();
        let storage = directory.path().join("intended");
        let other = directory.path().join("existing");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("data"), b"preserved").unwrap();
        let alias = runtime_home_alias(directory.path(), &storage);
        fs::create_dir(alias.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&other, &alias).unwrap();
        assert!(prepare_runtime_home(&alias, Some(&storage)).is_err());
        assert_eq!(fs::read_link(&alias).unwrap(), other);
        assert_eq!(fs::read(other.join("data")).unwrap(), b"preserved");
        assert!(!storage.exists());
    }

    #[test]
    fn resolving_runtime_paths_does_not_require_runtime_files_or_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("Silo.app/Contents/MacOS/msb");
        let resource_dir = directory.path().join("Silo.app/Contents/Resources");
        let library = bundled_runtime_library(&executable, &resource_dir);
        assert!(!library.exists());
        #[cfg(target_os = "macos")]
        assert_eq!(
            library,
            directory
                .path()
                .join("Silo.app/Contents/Frameworks/libkrunfw.5.dylib")
        );
        let paths = RuntimePaths {
            storage_home: None,
            executable,
            library,
            home: directory.path().join("home"),
            metadata: directory.path().join("machines.json"),
            volumes: directory.path().join("volumes"),
        };
        assert!(matches!(
            run_msb(&paths, &["list".into()], READ_TIMEOUT),
            Err(RuntimeError::Unavailable(_))
        ));
    }

    #[test]
    fn host_resource_probe_returns_measured_cpu_and_memory() {
        let measured = host_resources().unwrap();
        assert!(measured.logical_cpus > 0);
        assert!(measured
            .physical_memory_bytes
            .is_some_and(|bytes| bytes > 0));
    }

    #[test]
    fn configuration_progress_reports_real_boundaries_and_never_false_verification() {
        for fail_verification in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let paths = paths(&directory);
            let mut final_state = inspect(&paths, "Created");
            if fail_verification {
                final_state["config"]["resources"]["cpus"] = json!(1);
            }
            let runner = StubRunner::successful_json(vec![
                json!([]),
                json!(1),
                json!(null),
                inspect(&paths, "Created"),
                json!(null),
                inspect(&paths, "Stopped"),
                final_state,
            ]);
            let events = Mutex::new(Vec::new());
            let report = |step: &str, workspace: &str, fraction: u8| {
                events.lock().unwrap().push(machine_progress(
                    "request-1",
                    step,
                    workspace,
                    fraction,
                ))
            };
            let result = save_machine_configuration_with_progress(
                &runner,
                &paths,
                &generous_host(),
                request(vec![vm()]),
                &report,
            );
            assert_eq!(result.is_err(), fail_verification);
            let events = events.lock().unwrap();
            let boundaries: Vec<_> = events
                .iter()
                .filter_map(|event| {
                    event
                        .fraction
                        .map(|fraction| (event.step.as_str(), fraction))
                })
                .collect();
            let mut expected = vec![
                ("workspace-configuration", 0),
                ("workspace-configuration", 1),
                ("workspace-verification", 0),
            ];
            if !fail_verification {
                expected.push(("workspace-verification", 1));
            }
            assert_eq!(boundaries, expected);
            for event in events.iter() {
                let encoded = serde_json::to_value(event).unwrap();
                assert_eq!(encoded["type"], "progress");
                assert_eq!(encoded["requestId"], "request-1");
                assert_eq!(encoded["workspace"], "dev");
                assert_eq!(encoded["safeForDisplay"], true);
            }
        }
    }

    #[test]
    fn unchanged_saved_settings_do_not_hide_runtime_resource_mismatch() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let configured = request(vec![vm()]);
        write_metadata(&paths.metadata, &configured).unwrap();
        let mut mismatch = inspect(&paths, "Stopped");
        mismatch["config"]["resources"]["cpus"] = json!(1);
        let runner = StubRunner::successful_json(vec![mismatch]);
        let error = save_machine_configuration_with(&runner, &paths, &generous_host(), configured)
            .unwrap_err();
        assert!(error.to_string().contains("do not match"));
        assert!(runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|args| args[0] == "inspect"));
    }

    #[test]
    fn removal_preflight_checks_every_vm_before_deleting_any() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let first = vm();
        let mut second = vm();
        if let MachineConfiguration::Vm { id, name, .. } = &mut second {
            *id = "00000000-0000-4000-8000-000000000002".into();
            *name = "work".into();
        }
        let remote = MachineConfiguration::Ssh {
            id: "00000000-0000-4000-8000-000000000003".into(),
            name: "remote".into(),
            host: "example.com".into(),
            user: "user".into(),
            port: 22,
        };
        let previous = request(vec![first, second, remote.clone()]);
        write_metadata(&paths.metadata, &previous).unwrap();
        let runner = StubRunner::successful_json(vec![
            inspect(&paths, "Stopped"),
            inspect(&paths, "Running"),
        ]);
        assert!(save_machine_configuration_with(
            &runner,
            &paths,
            &generous_host(),
            request(vec![remote])
        )
        .is_err());
        assert!(runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|args| args[0] == "inspect"));
        assert_eq!(read_metadata(&paths.metadata).unwrap(), previous);
    }

    #[test]
    fn failed_later_removal_keeps_metadata_for_surviving_vms() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut second = vm();
        if let MachineConfiguration::Vm { id, name, .. } = &mut second {
            *id = "00000000-0000-4000-8000-000000000002".into();
            *name = "work".into();
        }
        let remote = MachineConfiguration::Ssh {
            id: "00000000-0000-4000-8000-000000000003".into(),
            name: "remote".into(),
            host: "example.com".into(),
            user: "user".into(),
            port: 22,
        };
        write_metadata(
            &paths.metadata,
            &request(vec![vm(), second.clone(), remote.clone()]),
        )
        .unwrap();
        let stopped = || {
            Ok(CommandOutput {
                stdout: inspect(&paths, "Stopped").to_string(),
                stderr: String::new(),
            })
        };
        let runner = StubRunner::new(vec![
            stopped(),
            stopped(),
            stopped(),
            Ok(CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
            }),
            stopped(),
            Err(RuntimeError::Unavailable("remove failed".into())),
        ]);
        let error = save_machine_configuration_with(
            &runner,
            &paths,
            &generous_host(),
            request(vec![remote.clone()]),
        )
        .unwrap_err();
        assert!(error.to_string().contains("Completed changes were kept"));
        assert_eq!(
            read_metadata(&paths.metadata).unwrap().machines,
            vec![second, remote]
        );
    }

    #[test]
    fn failed_multi_create_keeps_metadata_for_completed_creation() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let first = vm();
        let mut second = vm();
        if let MachineConfiguration::Vm { id, name, .. } = &mut second {
            *id = "00000000-0000-4000-8000-000000000002".into();
            *name = "work".into();
        }
        let runner = StubRunner::new(vec![
            Ok(CommandOutput {
                stdout: "[]".into(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: "1".into(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: inspect(&paths, "Created").to_string(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: inspect(&paths, "Stopped").to_string(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: inspect(&paths, "Created").to_string(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: "[]".into(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: "1".into(),
                stderr: String::new(),
            }),
            Err(RuntimeError::Failed {
                operation: "Creating the sandbox".into(),
                detail: "image pull failed".into(),
            }),
            Ok(CommandOutput {
                stdout: "[]".into(),
                stderr: String::new(),
            }),
            Ok(CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
            }),
        ]);

        let error = save_machine_configuration_with(
            &runner,
            &paths,
            &generous_host(),
            request(vec![first, second]),
        )
        .unwrap_err();

        assert!(error.to_string().contains("image pull failed"));
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| args[0] == "remove"));
        assert_eq!(read_metadata(&paths.metadata).unwrap().machines, vec![vm()]);
        assert!(error.to_string().contains("Completed changes were kept"));
    }

    #[test]
    fn remove_refuses_a_running_vm_without_stopping_it_implicitly() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let runner = StubRunner::successful_json(vec![inspect(&paths, "Running")]);

        let error = remove_machine(&runner, &paths, &vm()).unwrap_err();
        assert!(error.to_string().contains("Stop sandbox 'dev'"));
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }
}

#[cfg(test)]
#[path = "runtime_github_tests.rs"]
mod github_integration_tests;
