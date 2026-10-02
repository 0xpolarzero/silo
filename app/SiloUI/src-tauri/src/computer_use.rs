//! Built-in computer use for VMs created from a v4 or later guest image.
//!
//! Every such VM mounts the computer's published ChatGPT app folder read-only at
//! `/opt/silo/chatgpt` (see `chatgpt_app`). After each boot, and whenever the app
//! becomes ready, Silo pushes `guest/silo-computer-use.py` and the pinned
//! app/LCU pair into the guest and runs its `apply`, which installs LCU against the
//! mounted app and runs `lcu setup` with the VM's approval mode. The host drives the
//! guest toward the mode the user chose and remembers how each attempt ended; the guest
//! is a plain executor. See
//! `docs/SiloUI-CHATGPT-APP.md` and `docs/SiloUI-COMPUTER-USE-PLAN.md`.
use crate::{
    chatgpt_app::{self, DebArch, Status},
    desktop,
    runtime::{self, MachineConfiguration, RuntimeError, RuntimePaths, RuntimeRunner},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

/// Where the guest sees the computer's published ChatGPT app folder.
pub(crate) const GUEST_MOUNT: &str = "/opt/silo/chatgpt";
const HELPER: &str = include_str!("../guest/silo-computer-use.py");
const LCU_LOCK: &str = include_str!("../guest/lcu-lock.json");
const GUEST_HELPER: &str = "/usr/local/libexec/silo-computer-use";
/// The most one run of the guest helper may take (install, setup and the readiness check
/// with its bounded wait for the desktop session), and the host's allowance on top of it
/// for starting the command and collecting its output.
const APPLY_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const APPLY_GRACE: Duration = Duration::from_secs(60);

// ------------------------------------------------------------- approval

/// Whether an agent's computer-use actions in a VM ask for approval first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Approval {
    #[default]
    Ask,
    Auto,
}

impl Approval {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "ask" => Some(Self::Ask),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

/// What the guest last reported while the VM ran, shown while it is stopped.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Known {
    state: String,
    #[serde(default)]
    compatibility: Option<String>,
    #[serde(default)]
    warning: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    runtime_version: Option<String>,
    #[serde(default)]
    lcu_version: Option<String>,
    #[serde(default)]
    agents: Option<Vec<String>>,
}

/// How one run of the guest helper ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Outcome {
    Applied,
    Failed,
    /// `lcu setup` configured some agents and failed for others.
    Partial,
}

impl Outcome {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "applied" => Some(Self::Applied),
            "failed" => Some(Self::Failed),
            "partial" => Some(Self::Partial),
            _ => None,
        }
    }
}

/// The last attempt to apply an approval mode in the guest: what was tried and how it
/// ended. Kept until a later attempt replaces it; nothing is assumed rolled back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attempt {
    pub(crate) mode: Approval,
    pub(crate) outcome: Outcome,
    /// Seconds since the Unix epoch.
    pub(crate) at: u64,
    /// A stable code (see `reason_text`); only for a failure or a partial application.
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

/// The VM's approval policy, kept in `<storage>/computer-use/<id>.json`: the mode the user
/// chose (`approval`, the desired one), the last mode that was applied completely
/// (`applied`) and the last attempt. Only a user change, a fork or an apply writes it, all
/// under one lock, so a status read never changes it. Files of older versions carry a
/// revision and a generation; they are ignored.
///
/// The switch is a convenience, not a security boundary: agents in the VM have root and
/// can edit their own harness settings. The host therefore only drives the guest toward
/// the chosen mode and remembers how that went.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Policy {
    #[serde(default)]
    pub(crate) approval: Approval,
    #[serde(default)]
    pub(crate) applied: Option<Approval>,
    #[serde(default)]
    pub(crate) last: Option<Attempt>,
    /// The mode of an attempt that started and has no result yet. Written before the
    /// helper runs and replaced by the result, so an attempt cut short by a crash or a
    /// power loss is still known afterwards: whatever `last` says, the guest may have
    /// been left half changed.
    #[serde(default)]
    pub(crate) unfinished: Option<Approval>,
}

impl Policy {
    /// Whether the guest must be driven toward the chosen mode: an attempt never ended, no
    /// attempt yet, the last one was for another mode, or it did not apply completely.
    pub(crate) fn needs_apply(&self) -> bool {
        self.unfinished.is_some()
            || self
                .last
                .as_ref()
                .is_none_or(|last| last.mode != self.approval || last.outcome != Outcome::Applied)
    }
}

/// Per-VM computer-use settings as read: the policy plus the last observation.
/// Removed with the VM.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Settings {
    pub(crate) approval: Approval,
    pub(crate) applied: Option<Approval>,
    pub(crate) last: Option<Attempt>,
    /// An attempt started and never recorded a result (see `Policy::unfinished`).
    pub(crate) unfinished: bool,
    pub(crate) known: Option<Known>,
    /// The policy file exists but cannot be read, so `approval` is only the fail-closed
    /// default and the user's choice is unknown.
    pub(crate) unreadable: bool,
}

/// Serializes every read-modify-write of a policy file.
static POLICY_LOCK: Mutex<()> = Mutex::new(());

fn directory(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("computer-use")
}

fn policy_path(paths: &RuntimePaths, id: &str) -> Option<PathBuf> {
    // Ids are UUIDs; anything else never names a file.
    uuid::Uuid::parse_str(id)
        .ok()
        .map(|id| directory(paths).join(format!("{id}.json")))
}

fn observed_path(paths: &RuntimePaths, id: &str) -> Option<PathBuf> {
    policy_path(paths, id).map(|path| path.with_extension("observed.json"))
}

fn read_json<T: serde::de::DeserializeOwned>(path: Option<PathBuf>) -> Option<T> {
    path.and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn read_policy(paths: &RuntimePaths, id: &str) -> Policy {
    read_policy_checked(paths, id).unwrap_or_default()
}

/// The stored policy: the default for a VM that has none yet, `None` when a file exists
/// but cannot be read or parsed (the user's choice is then unknown, not `ask`).
fn read_policy_checked(paths: &RuntimePaths, id: &str) -> Option<Policy> {
    let Some(path) = policy_path(paths, id) else {
        return Some(Policy::default());
    };
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(Policy::default()),
        Err(_) => None,
    }
}

/// The settings of VM `id`; a missing or unreadable file means the defaults (ask).
pub(crate) fn settings(paths: &RuntimePaths, id: &str) -> Settings {
    let checked = read_policy_checked(paths, id);
    let unreadable = checked.is_none();
    let policy = checked.unwrap_or_default();
    Settings {
        approval: policy.approval,
        applied: policy.applied,
        last: policy.last,
        unfinished: policy.unfinished.is_some(),
        known: read_json(observed_path(paths, id)),
        unreadable,
    }
}

fn write_atomic<T: Serialize>(
    paths: &RuntimePaths,
    path: Option<PathBuf>,
    value: &T,
) -> Result<(), RuntimeError> {
    let fail = || RuntimeError::Unavailable("Silo could not save the computer-use setting.".into());
    let path =
        path.ok_or_else(|| RuntimeError::Invalid("Silo could not identify this sandbox.".into()))?;
    let directory = directory(paths);
    runtime::prepare_private_directory(&directory).map_err(|_| fail())?;
    let bytes = serde_json::to_vec(value).map_err(|_| fail())?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory).map_err(|_| fail())?;
    std::io::Write::write_all(&mut temporary, &bytes).map_err(|_| fail())?;
    temporary.as_file().sync_all().map_err(|_| fail())?;
    temporary.persist(path).map_err(|_| fail())?;
    Ok(())
}

fn lock_policies() -> std::sync::MutexGuard<'static, ()> {
    POLICY_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Stores a new approval choice and returns the stored policy. The last attempt is kept:
/// it is compared with the choice, never rewritten by it.
pub(crate) fn set_approval(
    paths: &RuntimePaths,
    id: &str,
    approval: Approval,
) -> Result<Policy, RuntimeError> {
    let _lock = lock_policies();
    // An unreadable file is replaced: the user's explicit choice repairs it.
    let mut policy = read_policy(paths, id);
    policy.approval = approval;
    write_atomic(paths, policy_path(paths, id), &policy)?;
    Ok(policy)
}

/// Remembers how an attempt to apply a mode ended. Touches only the attempt (and the
/// last applied mode), never the user's choice, and writes nothing when the policy file
/// cannot be read (the choice would be lost).
fn record_attempt(paths: &RuntimePaths, id: &str, attempt: Attempt) {
    let _lock = lock_policies();
    let Some(mut policy) = read_policy_checked(paths, id) else {
        return;
    };
    if attempt.outcome == Outcome::Applied {
        policy.applied = Some(attempt.mode);
    }
    policy.last = Some(attempt);
    policy.unfinished = None;
    let _ = write_atomic(paths, policy_path(paths, id), &policy);
}

/// Marks an attempt for `mode` as started and returns the marker it replaced, so an run
/// that turns out not to be an attempt can put it back (`restore_unfinished`).
fn begin_attempt(paths: &RuntimePaths, id: &str, mode: Approval) -> Option<Approval> {
    let _lock = lock_policies();
    let mut policy = read_policy_checked(paths, id)?;
    let previous = policy.unfinished.replace(mode);
    let _ = write_atomic(paths, policy_path(paths, id), &policy);
    previous
}

fn restore_unfinished(paths: &RuntimePaths, id: &str, previous: Option<Approval>) {
    let _lock = lock_policies();
    let Some(mut policy) = read_policy_checked(paths, id) else {
        return;
    };
    policy.unfinished = previous;
    let _ = write_atomic(paths, policy_path(paths, id), &policy);
}

/// The policy an apply works from. A policy file that cannot be read is replaced by the
/// default (ask) first: the user's choice is already lost, and failing closed keeps the
/// guest from running with a mode nobody chose.
fn policy_for_apply(paths: &RuntimePaths, id: &str) -> Policy {
    let _lock = lock_policies();
    match read_policy_checked(paths, id) {
        Some(policy) => policy,
        None => {
            let policy = Policy::default();
            let _ = write_atomic(paths, policy_path(paths, id), &policy);
            policy
        }
    }
}

/// A fork starts with its source's approval mode and nothing else: its guest disk
/// carries the source's configuration, so no attempt is known and its first boot applies.
pub(crate) fn inherit_settings(paths: &RuntimePaths, from: &str, to: &str) {
    let _lock = lock_policies();
    let approval = read_policy(paths, from).approval;
    let _ = write_atomic(
        paths,
        policy_path(paths, to),
        &Policy {
            approval,
            ..Policy::default()
        },
    );
}

/// Removes the settings of a deleted VM, or of an imported one: an import or transfer
/// starts from the destination's default (ask) with no attempt known, so its first boot
/// applies the default over whatever configuration the imported disk carries.
pub(crate) fn forget(paths: &RuntimePaths, id: &str) {
    let _lock = lock_policies();
    for path in [policy_path(paths, id), observed_path(paths, id)]
        .into_iter()
        .flatten()
    {
        let _ = fs::remove_file(path);
    }
}

/// Records what the guest last reported. Touches only the observation file.
fn remember(paths: &RuntimePaths, id: &str, known: Known) {
    if read_json::<Known>(observed_path(paths, id)).as_ref() != Some(&known) {
        let _ = write_atomic(paths, observed_path(paths, id), &known);
    }
}

/// VM id -> the number of applies scheduled or running for it, so the state says
/// `pending` while one is on its way.
static PENDING: Mutex<BTreeMap<String, usize>> = Mutex::new(BTreeMap::new());

/// Held by an apply from its scheduling until it ends, whatever the outcome.
struct Pending(String);

impl Pending {
    fn begin(id: &str) -> Self {
        *PENDING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(id.to_owned())
            .or_default() += 1;
        Self(id.to_owned())
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(count) = pending.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                pending.remove(&self.0);
            }
        }
    }
}

fn is_pending(id: &str) -> bool {
    PENDING
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains_key(id)
}

// ---------------------------------------------------------------- mount

static PUBLISHED: Mutex<Option<PathBuf>> = Mutex::new(None);
/// The ChatGPT storage root, remembered so the published folder can be prepared again
/// whenever it is missing (see `register_published`).
static STORAGE_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
#[cfg(test)]
thread_local! {
    static TEST_PUBLISHED: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Records the canonical published folder VMs mount (see `install`).
fn set_published_dir(dir: PathBuf) {
    *PUBLISHED.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir);
}

/// Prepares the published folder under `root` and registers its canonical path for
/// `mount_args`. Safe to repeat: the app start does it, every preparation attempt does it
/// again, and `mount_args` does it when no folder is registered, so a start-up that
/// failed (disk space, permissions) never leaves new VMs without the mount for the rest of
/// the session once the cause is gone.
pub(crate) fn register_published(root: &Path) -> Result<PathBuf, chatgpt_app::Error> {
    *STORAGE_ROOT.lock().unwrap_or_else(|p| p.into_inner()) = Some(root.to_path_buf());
    let dir = chatgpt_app::ensure_published_dir(root)?;
    set_published_dir(dir.clone());
    Ok(dir)
}

/// Registers the folder again from the remembered root without waiting for a download
/// that holds the storage lock (this runs while a VM is being created).
fn register_published_now() -> Option<PathBuf> {
    let root = STORAGE_ROOT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()?;
    let dir = chatgpt_app::ensure_published_dir_nowait(&root).ok()?;
    set_published_dir(dir.clone());
    Some(dir)
}

#[cfg(test)]
fn reset_published_for_test() {
    *PUBLISHED.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *STORAGE_ROOT.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// The canonical `<app data>/chatgpt/published` folder, once Silo prepared it.
pub(crate) fn published_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = TEST_PUBLISHED.with(|dir| dir.borrow().clone()) {
        return Some(dir);
    }
    PUBLISHED.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

#[cfg(test)]
pub(crate) fn set_test_published_dir(dir: Option<PathBuf>) {
    TEST_PUBLISHED.with(|slot| *slot.borrow_mut() = dir);
}

/// Whether the VM was created with the built-in desktop (v4 image) and so with the mount.
pub(crate) fn is_built_in(machine: &MachineConfiguration) -> bool {
    desktop::configuration(machine).is_some_and(|configuration| configuration.built_in)
}

fn mount_spec(dir: &Path) -> String {
    format!("{}:{GUEST_MOUNT}:ro", dir.display())
}

/// The `msb create` / `msb restore` arguments that mount the published folder: empty
/// for a VM without built-in computer use, an error when it needs the folder and
/// Silo has none (the VM would never get computer use). MicroSandbox refuses a
/// symlinked mount root, so the path is canonical.
pub(crate) fn mount_args(machine: &MachineConfiguration) -> Result<Vec<String>, RuntimeError> {
    if !is_built_in(machine) {
        return Ok(Vec::new());
    }
    // Only a missing or unusable folder blocks. An existing folder is mounted whatever it
    // holds: the ChatGPT app downloads in the background and a VM must not wait for it
    // (the guest reports the app as not ready until it appears).
    let unavailable = || {
        RuntimeError::Unavailable(
            "Silo could not prepare the shared ChatGPT folder for computer use. Restart Silo and try again.".into(),
        )
    };
    let dir = published_dir()
        .filter(|dir| dir.is_dir())
        .or_else(register_published_now)
        .ok_or_else(unavailable)?;
    Ok(vec!["-v".into(), mount_spec(&dir)])
}

/// Whether a sandbox's inspected configuration has the read-only computer-use mount
/// that `machine` needs (always true for a VM without built-in computer use).
pub(crate) fn mount_present(config: &Value, machine: &MachineConfiguration) -> bool {
    if !is_built_in(machine) {
        return true;
    }
    config
        .get("mounts")
        .and_then(Value::as_array)
        .is_some_and(|mounts| {
            mounts
                .iter()
                .any(|mount| is_computer_use_mount(mount) && read_only(mount))
        })
}

fn is_computer_use_mount(mount: &Value) -> bool {
    mount.get("type").and_then(Value::as_str) == Some("Bind")
        && mount.get("guest").and_then(Value::as_str) == Some(GUEST_MOUNT)
}

fn read_only(mount: &Value) -> bool {
    mount.pointer("/options/readonly").and_then(Value::as_bool) == Some(true)
        || mount.get("readonly").and_then(Value::as_bool) == Some(true)
}

/// Removes the computer-use mount from a configuration about to be exported. Its host
/// path means nothing on another computer; the importing Silo mounts its own folder
/// because the VM settings say `builtIn`. A writable mount at that path is refused.
pub(crate) fn strip_mount_for_export(config: &mut Value) -> Result<(), String> {
    let Some(mounts) = config.get_mut("mounts").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    if mounts
        .iter()
        .any(|mount| is_computer_use_mount(mount) && !read_only(mount))
    {
        return Err(
            "The sandbox mounts the shared ChatGPT folder writable, so it cannot be exported."
                .into(),
        );
    }
    mounts.retain(|mount| !is_computer_use_mount(mount));
    Ok(())
}

// ----------------------------------------------------------- pinned pair

/// The tested app/LCU pair this build installs, per guest architecture.
pub(crate) fn pinned(arch: DebArch) -> Result<Value, String> {
    let app = chatgpt_app::Lock::bundled().map_err(|e| e.message)?;
    let lcu: Value = serde_json::from_str(LCU_LOCK).map_err(|_| "LCU lock is invalid.")?;
    let version = lcu["version"].as_str().ok_or("LCU lock is invalid.")?;
    if app.lcu_version.as_deref() != Some(version) {
        return Err("The ChatGPT app and LCU locks name different LCU versions.".into());
    }
    let asset = &lcu["assets"][arch.name()];
    let url = asset["url"].as_str().ok_or("LCU lock is invalid.")?;
    let sha256 = asset["sha256"].as_str().ok_or("LCU lock is invalid.")?;
    let archive = url.rsplit('/').next().unwrap_or_default();
    Ok(json!({
        "schemaVersion": 1,
        "app": {
            "dir": app.directory_name(arch),
            "version": app.version,
            "runtime": app.cua_runtime_version,
        },
        "lcu": {"version": version, "archive": archive, "url": url, "sha256": sha256},
    }))
}

/// A shell script that installs the helper and the pinned pair in the guest, then
/// runs `command` (a helper invocation).
fn guest_script(pinned: &Value, command: &str) -> String {
    format!(
        "set -eu\ncu_stage=$(mktemp -d /tmp/silo-cu.XXXXXXXX)\ntrap 'rm -rf \"$cu_stage\"' EXIT\n\
cat > \"$cu_stage/helper\" <<'SILO_CU_HELPER_EOF'\n{HELPER}\nSILO_CU_HELPER_EOF\n\
cat > \"$cu_stage/pinned.json\" <<'SILO_CU_PINNED_EOF'\n{pinned}\nSILO_CU_PINNED_EOF\n\
install -d -m 0755 /usr/local/libexec /var/lib/silo-computer-use\n\
install -m 0755 -o root -g root \"$cu_stage/helper\" {GUEST_HELPER}\n\
install -m 0644 -o root -g root \"$cu_stage/pinned.json\" /var/lib/silo-computer-use/pinned.json\n\
{command}\n"
    )
}

/// The guest command that reads computer-use status (empty object when no helper yet).
pub(crate) const STATUS_COMMAND: &str =
    "if [ -x /usr/local/libexec/silo-computer-use ]; then /usr/local/libexec/silo-computer-use status; else printf '%s\\n' '{}'; fi";

fn apply_command(mode: Approval, force: bool, boot: bool) -> String {
    let mut command = format!("{GUEST_HELPER} apply --approval {}", mode.as_str());
    if force {
        command.push_str(" --force");
    }
    if boot {
        command.push_str(" --boot");
    }
    command
}

/// What one helper run reported about the approval it was asked to apply.
#[derive(Debug, PartialEq, Eq)]
enum Report {
    /// The run reached `lcu setup` (or found it done) and ended this way.
    Done(Outcome, Option<String>),
    /// The guest cannot apply yet because the ChatGPT app is not there. Not a result:
    /// the next boot or the app becoming ready applies.
    NotReady,
}

type Run = Result<(Value, Report), RuntimeError>;

/// The pinned runtime ends an `exec` that outlives its `--timeout` with a plain failure,
/// `exec timed out after <n>s` (crates/cli/lib/commands/exec.rs, `drive_stream`), after
/// killing the guest command. That is a timeout, not an unreachable sandbox.
fn timeout_as_timed_out(error: RuntimeError) -> RuntimeError {
    match error {
        RuntimeError::Failed {
            operation, detail, ..
        } if detail.lines().any(|line| {
            line.trim()
                .trim_start_matches("Error:")
                .trim()
                .strip_prefix("exec timed out after ")
                .and_then(|rest| rest.strip_suffix('s'))
                .is_some_and(|secs| !secs.is_empty() && secs.bytes().all(|b| b.is_ascii_digit()))
        }) =>
        {
            RuntimeError::TimedOut { operation }
        }
        error => error,
    }
}

/// Runs the guest helper's `apply` to completion (never detached) within `APPLY_TIMEOUT`
/// and returns its status and the report of the run.
fn run_helper(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    mode: Approval,
    force: bool,
    boot: bool,
) -> Run {
    let pinned = pinned(DebArch::host().map_err(|e| RuntimeError::Unavailable(e.message))?)
        .map_err(RuntimeError::Unavailable)?;
    let output = desktop::guest_within(
        runner,
        paths,
        name,
        &guest_script(&pinned, &apply_command(mode, force, boot)),
        APPLY_TIMEOUT,
        APPLY_GRACE,
        false,
    )
    .map_err(timeout_as_timed_out)?;
    let malformed = || RuntimeError::Malformed("Computer use returned an invalid status.".into());
    let status: Value = serde_json::from_str(output.lines().last().unwrap_or("").trim())
        .map_err(|_| malformed())?;
    let report = status.get("apply").ok_or_else(malformed)?;
    let outcome = report
        .get("outcome")
        .and_then(Value::as_str)
        .and_then(Outcome::parse)
        .ok_or_else(malformed)?;
    let reason = report
        .get("reason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let report = match (outcome, reason.as_deref()) {
        (Outcome::Failed, Some("app-missing" | "not-configured")) => Report::NotReady,
        _ => Report::Done(outcome, reason),
    };
    Ok((status, report))
}

/// The attempt to remember for a run, `None` when it was not an attempt at all.
fn attempt_of(mode: Approval, run: &Run) -> Option<Attempt> {
    let (outcome, reason) = match run {
        Ok((_, Report::NotReady)) => return None,
        Ok((_, Report::Done(outcome, reason))) => (*outcome, reason.clone()),
        Err(RuntimeError::Cancelled { .. }) => (Outcome::Failed, Some("cancelled".into())),
        Err(RuntimeError::TimedOut { .. }) => (Outcome::Failed, Some("timed-out".into())),
        Err(RuntimeError::Malformed(_)) => (Outcome::Failed, Some("invalid-report".into())),
        Err(_) => (Outcome::Failed, Some("unreachable".into())),
    };
    Some(Attempt {
        mode,
        outcome,
        at: unix_seconds(),
        reason,
    })
}

/// One attempt to apply `mode`: marks it unfinished on disk, runs the helper and replaces
/// the marker with the result. A run that was not an attempt (the app is not there yet)
/// leaves the marker as it was.
fn run_attempt(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    id: &str,
    name: &str,
    mode: Approval,
    force: bool,
    boot: bool,
) -> Run {
    let previous = begin_attempt(paths, id, mode);
    let run = run_helper(runner, paths, name, mode, force, boot);
    match attempt_of(mode, &run) {
        Some(attempt) => record_attempt(paths, id, attempt),
        None => restore_unfinished(paths, id, previous),
    }
    run
}

// ---------------------------------------------------------------- hooks

fn built_in_machine(paths: &RuntimePaths, name: &str) -> Option<MachineConfiguration> {
    runtime::read_metadata(&paths.metadata)
        .ok()?
        .machines
        .into_iter()
        .find(|machine| machine.is_vm() && machine.name() == name && is_built_in(machine))
}

/// A runner the background apply can own.
pub(crate) type SharedRunner = Arc<dyn RuntimeRunner + Send + Sync>;

/// A running VM's identity: the runtime instance that is running now and the Silo VM id
/// its runtime sandbox carries. `None` unless the VM runs, is labelled with `id` and
/// the runtime names its instance: an identity that cannot be established is never trusted.
fn running_identity(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    id: &str,
) -> Option<String> {
    // Asks the runtime directly: a VM restored from a checkpoint is still recorded as
    // pending while the restore that boots it runs `prepare_booted`, and `observe_vm`
    // would call it absent.
    let inspected = runtime::inspect_workspace(runner, paths, name).ok()?;
    let labelled = inspected
        .config
        .pointer("/labels/silo.machine-id")
        .and_then(Value::as_str)
        == Some(id);
    if inspected.status != "Running" || !labelled {
        return None;
    }
    // A runtime that lacks the capability is reported by name, not skipped silently.
    runtime::running_instance_id(paths, &inspected)
        .ok()
        .flatten()
}

/// How long a queued apply waits for its turn before it gives up (the next boot or app
/// start applies again).
const GATE_WAIT: Duration = Duration::from_secs(10 * 60);

/// Label of the apply's queue entry; other work is never preempted by an identical one.
const SYNC_LABEL: &str = "Setting up computer use in";

/// Ends the helper's turn quickly when work that must not wait queues for it: a stop or
/// delete of the same VM (a delete is computer-wide and names its targets, see
/// `OperationGate::removing`), or a computer-wide shutdown (Quit, update). Sets the running
/// operation's cancel flag, which the runtime's polling loops observe by killing the
/// child. The cut-short apply is recorded as such and tried again at the next boot or
/// app start; a stopped VM has nothing to apply.
struct Preempt {
    done: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Preempt {
    fn watch(
        gate: &'static runtime::operation_gate::OperationGate,
        id: &str,
        token: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        use runtime::operation_gate::OperationKind;
        use std::sync::atomic::Ordering;
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (flag, id) = (done.clone(), id.to_owned());
        let thread = std::thread::Builder::new()
            .name("computer-use-preempt".into())
            .spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    // A queued deletion of this VM names it only in its targets.
                    let blocked = gate.removal_queued(&id)
                        || gate.snapshot().waiting.iter().any(|entry| {
                            !entry.label.starts_with(SYNC_LABEL)
                                && match entry.kind {
                                    // Quit or update: computer-wide, whatever VM it names.
                                    OperationKind::Shutdown => true,
                                    OperationKind::Lifecycle => {
                                        entry.vm_id.as_deref() == Some(id.as_str())
                                    }
                                    _ => false,
                                }
                        });
                    if blocked {
                        token.store(true, Ordering::SeqCst);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
            .ok();
        Self { done, thread }
    }
}

impl Drop for Preempt {
    fn drop(&mut self) {
        self.done.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Why an apply runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trigger {
    /// A boot or the ChatGPT app becoming ready: always runs the helper, which installs
    /// and sets up whatever is missing and is cheap when nothing is.
    Boot,
    /// The user changed the switch, or the app started and found the last attempt
    /// incomplete: runs only while the VM's policy still needs it when its turn comes, so
    /// a queued apply that an earlier one made redundant does nothing.
    Change,
}

/// After a VM boots (start or restore): installs and configures computer use in the
/// background. Returns at once, never fails the boot, and never waits for the guest:
/// running the helper happens on a host thread (returned for tests).
pub(crate) fn after_boot(
    runner: SharedRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Option<std::thread::JoinHandle<()>> {
    apply_with(&runtime::OPERATIONS, runner, paths, name, Trigger::Boot)
}

/// Drives a running built-in VM's guest toward the VM's chosen approval mode on a host
/// thread, and returns the thread (for tests); `None` unless the VM is the running,
/// labelled built-in one.
///
/// The thread takes the VM's operation turn, which is the per-VM lock that serializes
/// applies (and any other work on the VM) and keeps a stop, delete or recreate from
/// replacing the VM between the identity check and the helper. Inside the turn it
/// confirms the VM is the same recorded machine and the same running instance, then reads
/// the *current* choice and runs the helper synchronously within `APPLY_TIMEOUT`, so a
/// queued apply never writes an older choice over a newer one. The turn is cancellable:
/// it yields to a queued stop or delete of this VM and to Quit (`Preempt`). The outcome
/// is recorded in every case, and the boot that scheduled the thread never waits for it.
fn apply_with(
    gate: &'static runtime::operation_gate::OperationGate,
    runner: SharedRunner,
    paths: &RuntimePaths,
    name: &str,
    trigger: Trigger,
) -> Option<std::thread::JoinHandle<()>> {
    let machine = built_in_machine(paths, name)?;
    let id = machine.id().to_owned();
    let instance = running_identity(runner.as_ref(), paths, name, &id)?;
    // Registered before the thread starts, so a state read right after a change says
    // `pending` (and a boot that has nothing to change is not shown as applying).
    let pending = read_policy(paths, &id)
        .needs_apply()
        .then(|| Pending::begin(&id));
    let (paths, name) = (paths.clone(), name.to_owned());
    std::thread::Builder::new()
        .name("computer-use-apply".into())
        .spawn(move || {
            let _pending = pending;
            let deadline = std::time::Instant::now() + GATE_WAIT;
            let Ok(turn) = gate
                .kind(runtime::operation_gate::OperationKind::Other)
                .acquire_while(
                    runtime::operation_gate::Scope::Vm { id: id.clone() },
                    Some(name.clone()),
                    &format!("{SYNC_LABEL} {name}"),
                    &|| std::time::Instant::now() < deadline,
                )
            else {
                return;
            };
            turn.allow_cancel();
            let _preempt = Preempt::watch(gate, &id, turn.cancel_token());
            let same_vm = built_in_machine(&paths, &name).is_some_and(|m| m.id() == id)
                && running_identity(runner.as_ref(), &paths, &name, &id).as_deref()
                    == Some(instance.as_str());
            if !same_vm {
                return;
            }
            let mut trigger = trigger;
            loop {
                let policy = policy_for_apply(&paths, &id);
                let mode = policy.approval;
                if trigger == Trigger::Change && !policy.needs_apply() {
                    return;
                }
                let run = run_attempt(
                    runner.as_ref(),
                    &paths,
                    &id,
                    &name,
                    mode,
                    false,
                    trigger == Trigger::Boot,
                );
                match &run {
                    Err(RuntimeError::Cancelled { .. }) | Ok(_) => {}
                    Err(error) => {
                        eprintln!("Computer use could not be applied in {name}: {error}")
                    }
                }
                // A cut-short or not-yet-possible apply ends here (the next boot or the
                // app becoming ready tries again). Otherwise the user may have chosen
                // another mode while the helper ran, and the change that did it found an
                // earlier result for that mode and scheduled nothing: converge now, inside
                // the turn, on whatever is chosen at this moment.
                if matches!(
                    run,
                    Err(RuntimeError::Cancelled { .. }) | Ok((_, Report::NotReady))
                ) || turn
                    .cancel_token()
                    .load(std::sync::atomic::Ordering::SeqCst)
                    || read_policy(&paths, &id).approval == mode
                {
                    return;
                }
                trigger = Trigger::Change;
            }
        })
        .ok()
}

/// At app start, after the runtime is ready: finishes approval changes whose apply never
/// ran, failed or was cut short (the app quit, the guest failed, the VM stopped), so a
/// running guest does not keep an old mode. The host never reads the guest to decide:
/// its own record of the last attempt is enough. Returns the threads started, one per
/// VM that needs it (for tests).
fn reconcile_in(
    gate: &'static runtime::operation_gate::OperationGate,
    runner: &SharedRunner,
    paths: &RuntimePaths,
    running: &[String],
) -> Vec<std::thread::JoinHandle<()>> {
    running
        .iter()
        .filter_map(|name| {
            let machine = built_in_machine(paths, name)?;
            read_policy(paths, machine.id())
                .needs_apply()
                .then_some(())?;
            apply_with(gate, runner.clone(), paths, name, Trigger::Change)
        })
        .collect()
}

/// `reconcile_in` for every running VM of this computer. Returns at once.
pub(crate) fn reconcile(app: &AppHandle) {
    let Ok(paths) = runtime::runtime_paths(app) else {
        return;
    };
    let Ok(running) = runtime::update_recovery::running_names(app) else {
        return;
    };
    let runner: SharedRunner = Arc::new(runtime::ProcessRunner);
    let handles = reconcile_in(&runtime::OPERATIONS, &runner, &paths, &running);
    if handles.is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for handle in handles {
            let _ = handle.join();
        }
        let _ = app.emit("silo://application-state-changed", ());
    });
}

/// The ChatGPT app became ready: running built-in VMs set up computer use now instead
/// of at their next boot. Stopped VMs do it when they start.
pub(crate) fn app_ready(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(paths) = runtime::runtime_paths(&app) else {
            return;
        };
        let Ok(running) = runtime::update_recovery::running_names(&app) else {
            return;
        };
        for name in running {
            let _ = after_boot(Arc::new(runtime::ProcessRunner), &paths, &name);
        }
        let _ = app.emit("silo://application-state-changed", ());
    });
}

// ------------------------------------------------------- reported state

fn reason_text(code: &str) -> &'static str {
    match code {
        "interrupted" => "Setup was interrupted. Choose Set up computer use to retry.",
        "doctor-failed" => "LCU's readiness check failed. Details are in /var/log/silo-computer-use.log in the sandbox.",
        "desktop-session-not-running" => "The Linux desktop was not running. Start it, then choose Set up computer use.",
        "timed-out" => "Setup timed out. Choose Set up computer use to retry.",
        "lcu-archive-unavailable" => "The LCU package is missing from this sandbox and could not be downloaded.",
        "lcu-archive-mismatch" | "lcu-archive-invalid" => "The LCU package did not pass verification.",
        "mount-missing" => "This sandbox has no shared ChatGPT folder. Create a new sandbox to use computer use.",
        "mount-writable" => "The shared ChatGPT folder is mounted writable; Silo refuses to use it.",
        _ => "Setup failed. Details are in /var/log/silo-computer-use.log in the sandbox.",
    }
}

/// Why applying the approval mode failed or only partly worked, for the panel.
fn approval_reason_text(code: &str) -> &'static str {
    match code {
        "cancelled" => "Applying was interrupted. Silo tries again when the sandbox starts.",
        "timed-out" => "Applying took too long. Silo tries again when the sandbox starts.",
        "unreachable" => "Silo could not reach the sandbox to apply it. Silo tries again when the sandbox starts.",
        "invalid-report" => "The sandbox returned an unreadable answer. Silo tries again when the sandbox starts.",
        "setup-partial" => "Some agents could not be configured. Details are in /var/log/silo-computer-use.log in the sandbox.",
        "mount-missing" | "mount-writable" => reason_text(code),
        _ => "Silo could not configure the agents' approval settings. Details are in /var/log/silo-computer-use.log in the sandbox.",
    }
}

fn compat(value: Option<&str>) -> &'static str {
    match value {
        Some("tested") => "tested",
        Some("untested") => "untested",
        _ => "unknown",
    }
}

/// Inputs to `computer_use_state` that do not need a guest.
pub(crate) struct Inputs<'a> {
    /// The ChatGPT app status on this computer; `None` until it was first checked.
    pub(crate) app: Option<&'a Status>,
    pub(crate) vm_running: bool,
    /// The helper's `status` output, when the VM runs and reported one.
    pub(crate) guest: Option<&'a Value>,
    pub(crate) settings: &'a Settings,
    /// An apply of the chosen mode is scheduled or running.
    pub(crate) pending: bool,
}

/// How applying the chosen mode stands: `applied`, `pending` (scheduled, running, or
/// waiting for the sandbox to start), `failed` or `partial`. Judged against the *last
/// attempt*, never the guest: a failed or partial attempt stays visible until a later one
/// applies completely, and an attempt for another mode says nothing about this one.
fn approval_apply(settings: &Settings, pending: bool) -> &'static str {
    if pending {
        return "pending";
    }
    if settings.unfinished {
        return "pending";
    }
    match &settings.last {
        Some(last) if last.mode == settings.approval => match last.outcome {
            Outcome::Applied => "applied",
            Outcome::Failed => "failed",
            Outcome::Partial => "partial",
        },
        _ => "pending",
    }
}

fn state_object(
    state: &str,
    reason: Option<&str>,
    inputs: &Inputs,
    details: Option<&Known>,
) -> Value {
    let settings = inputs.settings;
    let known = details.cloned().unwrap_or_default();
    let apply = approval_apply(settings, inputs.pending);
    let apply_reason = settings
        .last
        .as_ref()
        .filter(|_| matches!(apply, "failed" | "partial"))
        .and_then(|last| last.reason.as_deref())
        .map(approval_reason_text);
    json!({
        "state": state,
        "reason": reason,
        "compatibility": compat(known.compatibility.as_deref()),
        "warning": known.warning,
        // `approval` is what the user chose (unknown when the saved choice cannot be
        // read). `appliedApproval` is the last mode that was applied completely, `unknown`
        // before any was, whatever the state of the app download or the guest. `approvalApply`
        // is how applying the chosen mode stands.
        "approval": if settings.unreadable { "unknown" } else { settings.approval.as_str() },
        "appliedApproval": settings.applied.map_or("unknown", Approval::as_str),
        "approvalApply": apply,
        "approvalApplyReason": apply_reason,
        "appVersion": known.app_version,
        "runtimeVersion": known.runtime_version,
        "lcuVersion": known.lcu_version,
        "agents": known.agents,
    })
}

/// The `computerUse` object of the desktop state, plus what to remember for later.
pub(crate) fn computer_use_state(inputs: &Inputs) -> (Value, Option<Known>) {
    let known = inputs.settings.known.as_ref();
    match inputs.app {
        None => {
            return (
                state_object(
                    "preparing",
                    Some("Checking the ChatGPT app."),
                    inputs,
                    known,
                ),
                None,
            )
        }
        Some(Status::Idle) => {
            return (
                state_object(
                    "preparing",
                    Some("Waiting to download ChatGPT for Linux."),
                    inputs,
                    known,
                ),
                None,
            )
        }
        Some(Status::Downloading { .. } | Status::Verifying | Status::Extracting) => {
            return (
                state_object(
                    "preparing",
                    Some("Preparing ChatGPT for Linux."),
                    inputs,
                    known,
                ),
                None,
            )
        }
        // Silo retries a retryable failure by itself, so the sandbox is still preparing.
        Some(Status::Failed {
            reason,
            retryable: true,
        }) => {
            let reason = format!("{reason} Silo tries again automatically.");
            return (
                state_object("preparing", Some(&reason), inputs, known),
                None,
            );
        }
        // The host download failed for good: setting up the guest cannot fix it.
        Some(Status::Failed { reason, .. }) => {
            let mut state = state_object("failed", Some(reason), inputs, known);
            state["cause"] = json!("app-download");
            return (state, None);
        }
        Some(Status::Ready { .. }) => {}
    }
    if !inputs.vm_running {
        return match known.filter(|known| matches!(known.state.as_str(), "ready" | "failed")) {
            Some(known) => {
                let reason = (known.state == "failed").then(|| reason_text("setup-failed"));
                (
                    state_object(&known.state, reason, inputs, Some(known)),
                    None,
                )
            }
            None => (
                state_object(
                    "unavailable",
                    Some("Start the sandbox to set up computer use."),
                    inputs,
                    known,
                ),
                None,
            ),
        };
    }
    let Some(guest) = inputs.guest.filter(|guest| guest.get("state").is_some()) else {
        return (
            state_object(
                "unavailable",
                Some("Computer use is not set up yet. Choose Set up computer use."),
                inputs,
                known,
            ),
            None,
        );
    };
    let text = |field: &str| guest.get(field).and_then(Value::as_str).map(str::to_owned);
    let details = Known {
        state: text("state").unwrap_or_default(),
        compatibility: text("compatibility"),
        warning: text("warning"),
        app_version: text("appVersion"),
        runtime_version: text("runtimeVersion"),
        lcu_version: text("lcuVersion"),
        agents: guest.get("agents").and_then(Value::as_array).map(|agents| {
            agents
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        }),
    };
    let reason = text("reason");
    let (state, reason): (&str, Option<String>) = match details.state.as_str() {
        "ready" => ("ready", None),
        "installing" => ("installing", None),
        "failed" => (
            "failed",
            Some(reason_text(reason.as_deref().unwrap_or("setup-failed")).into()),
        ),
        "needs-app" => (
            "preparing",
            Some("Waiting for the ChatGPT folder inside the sandbox.".into()),
        ),
        _ => (
            "unavailable",
            Some("Computer use is not set up yet. Choose Set up computer use.".into()),
        ),
    };
    let remembered = matches!(state, "ready" | "failed").then(|| Known {
        state: state.into(),
        ..details.clone()
    });
    (
        state_object(state, reason.as_deref(), inputs, Some(&details)),
        remembered,
    )
}

/// The `computerUse` object for `machine`, or `None` for a VM without built-in
/// computer use. Reads only cached state; `guest` is the helper's status output.
pub(crate) fn desktop_state(
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    vm_running: bool,
    guest: Option<&Value>,
) -> Option<Value> {
    if !is_built_in(machine) {
        return None;
    }
    let current = settings(paths, machine.id());
    let app = chatgpt_app::cached_status();
    let (state, remembered) = computer_use_state(&Inputs {
        app: app.as_ref(),
        vm_running,
        guest,
        settings: &current,
        pending: is_pending(machine.id()),
    });
    if let Some(known) = remembered {
        remember(paths, machine.id(), known);
    }
    Some(state)
}

// -------------------------------------------------------- commands

/// Runs setup (or re-runs it for agents installed later) in a running VM and returns
/// the helper's status. The caller holds the VM's operation turn (`cancel` is its token), so this cannot overlap
/// a background apply; the run applies the chosen mode and records how that went.
pub(crate) fn setup_with(
    gate: &'static runtime::operation_gate::OperationGate,
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    force: bool,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Value, RuntimeError> {
    // Like an apply, the run yields to a queued stop or delete of this VM and to Quit.
    let _preempt = Preempt::watch(gate, machine.id(), cancel);
    let policy = policy_for_apply(paths, machine.id());
    let mode = policy.approval;
    let _pending = policy.needs_apply().then(|| Pending::begin(machine.id()));
    run_attempt(
        runner,
        paths,
        machine.id(),
        machine.name(),
        mode,
        force,
        false,
    )
    .map(|(status, _)| status)
}

/// Stores the VM's approval mode and, when it runs, applies it on a background thread
/// (returned for tests): the change returns at once and the state says `pending` until
/// the apply ends. A stopped VM picks it up at its next boot.
pub(crate) fn apply_approval_with(
    runner: SharedRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    approval: Approval,
    running: bool,
) -> Result<Option<std::thread::JoinHandle<()>>, RuntimeError> {
    apply_approval_in(
        &runtime::OPERATIONS,
        runner,
        paths,
        machine,
        approval,
        running,
    )
}

fn apply_approval_in(
    gate: &'static runtime::operation_gate::OperationGate,
    runner: SharedRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    approval: Approval,
    running: bool,
) -> Result<Option<std::thread::JoinHandle<()>>, RuntimeError> {
    let policy = set_approval(paths, machine.id(), approval)?;
    if !running || !policy.needs_apply() {
        return Ok(None);
    }
    Ok(apply_with(
        gate,
        runner,
        paths,
        machine.name(),
        Trigger::Change,
    ))
}

/// Prepares the shared folder and the status cache at app start, then downloads the
/// pinned ChatGPT app in the background when it is not published yet.
pub(crate) fn install(app: &AppHandle) {
    let Ok(root) = chatgpt_app::storage_root(app) else {
        return;
    };
    // Cheap (two directories), and a VM created right after launch needs it. A failure
    // here is retried before every preparation attempt and when a VM needs the folder.
    if let Err(error) = register_published(&root) {
        eprintln!("ChatGPT app folder unavailable: {}", error.message);
    }
    // Verifying the app tree the first time reads every byte (seconds): off the main thread.
    let app = app.clone();
    std::thread::spawn(move || chatgpt_app::start_automatic(&app));
}

#[cfg(test)]
mod tests;
