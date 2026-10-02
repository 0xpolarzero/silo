//! Built-in computer use for VMs created from a v4 or later guest image.
//!
//! Every such VM mounts the computer's published ChatGPT app folder read-only at
//! `/opt/silo/chatgpt` (see `chatgpt_app`). After each boot, and whenever the app
//! becomes ready, Silo pushes `guest/silo-computer-use.py` and the pinned
//! app/LCU pair into the guest and runs its `sync`, which installs LCU against the
//! mounted app and runs `lcu setup` with the VM's approval mode. See
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
const SYNC_TIMEOUT: Duration = Duration::from_secs(30 * 60);

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

/// The VM's approval policy: what the user chose and the revision of that choice.
/// Kept in `<storage>/computer-use/<id>.json`. Only a user change, a fork or the first
/// sync of an unstamped policy writes it; observations live in another file, so
/// reading and reporting status can never overwrite a newer choice.
///
/// The revision increases with every change (and starts from the clock, so it also
/// exceeds whatever an imported VM's guest applied elsewhere). The guest records the
/// revision it applied and ignores older requests, which keeps a delayed sync that
/// captured an earlier mode from undoing a later change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Policy {
    #[serde(default)]
    pub(crate) approval: Approval,
    #[serde(default)]
    pub(crate) revision: u64,
}

/// Per-VM computer-use settings as read: the policy plus the last observation.
/// Removed with the VM.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    #[serde(default)]
    pub(crate) approval: Approval,
    #[serde(default)]
    pub(crate) revision: u64,
    #[serde(default)]
    pub(crate) known: Option<Known>,
    /// This computer's owner id (empty until a sync created it); never serialized.
    #[serde(skip)]
    pub(crate) owner: String,
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
    read_json(policy_path(paths, id)).unwrap_or_default()
}

/// The settings of VM `id`; a missing or unreadable file means the defaults (ask).
pub(crate) fn settings(paths: &RuntimePaths, id: &str) -> Settings {
    let policy = read_policy(paths, id);
    Settings {
        approval: policy.approval,
        revision: policy.revision,
        known: read_json(observed_path(paths, id)),
        owner: read_owner(paths).unwrap_or_default(),
    }
}

fn owner_path(paths: &RuntimePaths) -> PathBuf {
    directory(paths).join("owner")
}

fn read_owner(paths: &RuntimePaths) -> Option<String> {
    let text = fs::read_to_string(owner_path(paths)).ok()?;
    uuid::Uuid::parse_str(text.trim())
        .ok()
        .map(|id| id.to_string())
}

/// This computer's owner id, created on first use. Every sync carries it. A guest that
/// last applied an approval for another owner (it was imported or transferred from
/// another computer) accepts this computer's policy whatever the revision numbers say,
/// because revisions are clock values that only order changes made by one computer.
fn owner(paths: &RuntimePaths) -> Result<String, RuntimeError> {
    let _lock = lock_policies();
    if let Some(owner) = read_owner(paths) {
        return Ok(owner);
    }
    let owner = uuid::Uuid::new_v4().to_string();
    let fail = || RuntimeError::Unavailable("Silo could not save the computer-use setting.".into());
    let directory = directory(paths);
    runtime::prepare_private_directory(&directory).map_err(|_| fail())?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory).map_err(|_| fail())?;
    std::io::Write::write_all(&mut temporary, owner.as_bytes()).map_err(|_| fail())?;
    temporary.as_file().sync_all().map_err(|_| fail())?;
    temporary.persist(owner_path(paths)).map_err(|_| fail())?;
    Ok(owner)
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

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// A revision above `previous` and, normally, above any older computer's.
fn next_revision(previous: u64) -> u64 {
    previous.saturating_add(1).max(unix_millis())
}

/// Stores a new approval choice and returns its revision.
pub(crate) fn set_approval(
    paths: &RuntimePaths,
    id: &str,
    approval: Approval,
) -> Result<u64, RuntimeError> {
    let _lock = lock_policies();
    let revision = next_revision(read_policy(paths, id).revision);
    write_atomic(
        paths,
        policy_path(paths, id),
        &Policy { approval, revision },
    )?;
    Ok(revision)
}

/// What a sync carries: the VM's policy and this computer's owner id. The guest orders
/// revisions only within one owner and accepts a new owner's policy outright, so an
/// imported or transferred VM takes this computer's choice (ask by default) even when the
/// source computer's clock, and so its revisions, were ahead.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SyncPolicy {
    policy: Policy,
    owner: String,
}

/// The policy a sync carries. A policy that was never stamped (a new, imported or
/// restored VM) gets a revision first, so the revision is meaningful for this owner.
fn sync_policy(paths: &RuntimePaths, id: &str) -> Result<SyncPolicy, RuntimeError> {
    let owner = owner(paths)?;
    let _lock = lock_policies();
    let mut policy = read_policy(paths, id);
    if policy.revision == 0 {
        policy.revision = next_revision(0);
        let _ = write_atomic(paths, policy_path(paths, id), &policy);
    }
    Ok(SyncPolicy { policy, owner })
}

/// A fork starts with its source's approval mode and nothing else.
pub(crate) fn inherit_settings(paths: &RuntimePaths, from: &str, to: &str) {
    let _lock = lock_policies();
    let source = read_policy(paths, from);
    let _ = write_atomic(paths, policy_path(paths, to), &source);
}

/// Removes the settings of a deleted VM.
pub(crate) fn forget(paths: &RuntimePaths, id: &str) {
    let _lock = lock_policies();
    for path in [policy_path(paths, id), observed_path(paths, id)]
        .into_iter()
        .flatten()
    {
        let _ = fs::remove_file(path);
    }
    APPLY_FAILED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(id);
}

/// Records what the guest last reported. Touches only the observation file.
fn remember(paths: &RuntimePaths, id: &str, known: Known) {
    if read_json::<Known>(observed_path(paths, id)).as_ref() != Some(&known) {
        let _ = write_atomic(paths, observed_path(paths, id), &known);
    }
}

/// VM id -> the approval revision whose application failed, so the state can say so
/// instead of waiting forever for the guest to catch up.
static APPLY_FAILED: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// Records the outcome of applying `revision`. Outcomes arrive out of order (an older
/// launcher can finish after a newer change failed), so a success clears only failures
/// at or below its own revision, and a failure never lowers a newer recorded one.
fn record_apply(id: &str, revision: u64, succeeded: bool) {
    let mut failed = APPLY_FAILED.lock().unwrap_or_else(|p| p.into_inner());
    if succeeded {
        if failed.get(id).is_some_and(|recorded| *recorded <= revision) {
            failed.remove(id);
        }
    } else {
        let recorded = failed.entry(id.to_owned()).or_insert(revision);
        *recorded = (*recorded).max(revision);
    }
}

#[cfg(test)]
fn forget_failure(id: &str) {
    APPLY_FAILED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(id);
}

fn apply_failed(id: &str, revision: u64) -> bool {
    APPLY_FAILED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(id)
        .is_some_and(|failed| *failed >= revision)
}

// ---------------------------------------------------------------- mount

static PUBLISHED: Mutex<Option<PathBuf>> = Mutex::new(None);
#[cfg(test)]
thread_local! {
    static TEST_PUBLISHED: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Records the canonical published folder VMs mount (see `install`).
fn set_published_dir(dir: PathBuf) {
    *PUBLISHED.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir);
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

fn policy_arguments(sync: &SyncPolicy) -> String {
    format!(
        " --approval {} --revision {} --owner {}",
        sync.policy.approval.as_str(),
        sync.policy.revision,
        sync.owner
    )
}

fn sync_command(policy: Option<&SyncPolicy>, force: bool) -> String {
    let mut command = format!("{GUEST_HELPER} sync");
    if force {
        command.push_str(" --force");
    }
    if let Some(policy) = policy {
        command.push_str(&policy_arguments(policy));
    }
    command
}

/// The guest command that reads computer-use status (empty object when no helper yet).
pub(crate) const STATUS_COMMAND: &str =
    "if [ -x /usr/local/libexec/silo-computer-use ]; then /usr/local/libexec/silo-computer-use status; else printf '%s\\n' '{}'; fi";

/// Pushes the helper and runs `sync` to completion; returns the helper's status.
fn sync_now(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    policy: &SyncPolicy,
    force: bool,
) -> Result<Value, RuntimeError> {
    let pinned = pinned(DebArch::host().map_err(|e| RuntimeError::Unavailable(e.message))?)
        .map_err(RuntimeError::Unavailable)?;
    let output = desktop::guest(
        runner,
        paths,
        name,
        &guest_script(&pinned, &sync_command(Some(policy), force)),
        SYNC_TIMEOUT,
        false,
    )?;
    serde_json::from_str(output.lines().last().unwrap_or("").trim())
        .map_err(|_| RuntimeError::Malformed("Computer use returned an invalid status.".into()))
}

/// Starts `sync` in the background (it can take minutes the first time) and returns at
/// once. The guest keeps running it after the command that launched it ends.
fn sync_detached(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    name: &str,
    policy: &SyncPolicy,
) -> Result<(), RuntimeError> {
    let pinned = pinned(DebArch::host().map_err(|e| RuntimeError::Unavailable(e.message))?)
        .map_err(RuntimeError::Unavailable)?;
    let command = format!(
        "( setsid {GUEST_HELPER} sync --boot{} >/dev/null 2>&1 </dev/null & )",
        policy_arguments(policy)
    );
    desktop::guest(
        runner,
        paths,
        name,
        &guest_script(&pinned, &command),
        Duration::from_secs(60),
        false,
    )
    .map(drop)
}

// ---------------------------------------------------------------- hooks

fn built_in_machine(paths: &RuntimePaths, name: &str) -> Option<MachineConfiguration> {
    runtime::read_metadata(&paths.metadata)
        .ok()?
        .machines
        .into_iter()
        .find(|machine| machine.is_vm() && machine.name() == name && is_built_in(machine))
}

/// A runner the background sync can own.
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
    inspected
        .runtime_instance_id
        .filter(|instance| !instance.is_empty())
}

/// How long a queued sync waits for its turn before it gives up (the next boot or app
/// start syncs again).
const GATE_WAIT: Duration = Duration::from_secs(10 * 60);

/// After a VM boots (start or restore): installs and configures computer use in the
/// background. Returns at once, never fails the boot, and never waits for the guest:
/// pushing the helper and starting its sync run on a host thread (returned for tests).
///
/// The thread takes the VM's operation turn, so a stop, delete or recreate cannot
/// replace the named VM between the identity check and the launcher; inside the turn it
/// confirms that the VM is the same recorded machine, the same labelled running
/// instance Silo saw at boot, and only then reads the approval policy and launches. A VM
/// whose identity could not be established at boot is never synced.
pub(crate) fn after_boot(
    runner: SharedRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Option<std::thread::JoinHandle<()>> {
    after_boot_with(&runtime::OPERATIONS, runner, paths, name)
}

fn after_boot_with(
    gate: &'static runtime::operation_gate::OperationGate,
    runner: SharedRunner,
    paths: &RuntimePaths,
    name: &str,
) -> Option<std::thread::JoinHandle<()>> {
    let machine = built_in_machine(paths, name)?;
    let id = machine.id().to_owned();
    let instance = running_identity(runner.as_ref(), paths, name, &id)?;
    let (paths, name) = (paths.clone(), name.to_owned());
    std::thread::Builder::new()
        .name("computer-use-sync".into())
        .spawn(move || {
            let deadline = std::time::Instant::now() + GATE_WAIT;
            let Ok(_turn) = gate
                .kind(runtime::operation_gate::OperationKind::Other)
                .acquire_while(
                    runtime::operation_gate::Scope::Vm { id: id.clone() },
                    Some(name.clone()),
                    &format!("Setting up computer use in {name}"),
                    &|| std::time::Instant::now() < deadline,
                )
            else {
                return;
            };
            let same_vm = built_in_machine(&paths, &name).is_some_and(|m| m.id() == id)
                && running_identity(runner.as_ref(), &paths, &name, &id).as_deref()
                    == Some(instance.as_str());
            if !same_vm {
                return;
            }
            let policy = match sync_policy(&paths, &id) {
                Ok(policy) => policy,
                Err(error) => {
                    eprintln!("Computer use could not be started in {name}: {error}");
                    return;
                }
            };
            let result = sync_detached(runner.as_ref(), &paths, &name, &policy);
            record_apply(&id, policy.policy.revision, result.is_ok());
            if let Err(error) = result {
                eprintln!("Computer use could not be started in {name}: {error}");
            }
        })
        .ok()
}

/// Whether a running guest still lacks the VM's saved approval policy: it applied an
/// older revision or another computer's choice, or it has no helper at all. Reads the
/// helper's status; a guest that cannot be asked is left to its next boot.
fn guest_behind(runner: &dyn RuntimeRunner, paths: &RuntimePaths, name: &str, id: &str) -> bool {
    let Ok(output) = desktop::guest(
        runner,
        paths,
        name,
        STATUS_COMMAND,
        Duration::from_secs(60),
        false,
    ) else {
        return false;
    };
    let Ok(status) = serde_json::from_str::<Value>(output.lines().last().unwrap_or("").trim())
    else {
        return false;
    };
    let current = settings(paths, id);
    let applied = status.get("approvalRevision").and_then(Value::as_u64);
    let owner = status.get("approvalOwner").and_then(Value::as_str);
    match applied {
        // No helper, or an older one: a sync installs and applies.
        None => true,
        Some(applied) => {
            applied < current.revision
                || status.get("approval").and_then(Value::as_str) != Some(current.approval.as_str())
                || owner != read_owner(paths).as_deref()
        }
    }
}

/// At app start, after the runtime is ready: finishes approval changes that were saved
/// but never launched (the app quit or crashed between saving a policy and starting
/// its sync), so a running guest does not keep the old mode with "Applying approval
/// change…" shown forever. Returns the threads started (for tests).
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
            guest_behind(runner.as_ref(), paths, name, machine.id()).then_some(())?;
            after_boot_with(gate, runner.clone(), paths, name)
        })
        .collect()
}

/// `reconcile_in` for every running VM of this computer. Runs on the caller's thread.
pub(crate) fn reconcile(app: &AppHandle) {
    let Ok(paths) = runtime::runtime_paths(app) else {
        return;
    };
    let Ok(running) = runtime::update_recovery::running_names(app) else {
        return;
    };
    let runner: SharedRunner = Arc::new(runtime::ProcessRunner);
    for handle in reconcile_in(&runtime::OPERATIONS, &runner, &paths, &running) {
        let _ = handle.join();
    }
    let _ = app.emit("silo://application-state-changed", ());
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
        "approval-failed" => "Silo could not apply the approval change. Choose Set up computer use to retry.",
        "mount-writable" => "The shared ChatGPT folder is mounted writable; Silo refuses to use it.",
        _ => "Setup failed. Details are in /var/log/silo-computer-use.log in the sandbox.",
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
    /// Applying `settings.revision` in the guest already failed.
    pub(crate) approval_failed: bool,
}

fn state_object(
    state: &str,
    reason: Option<&str>,
    settings: &Settings,
    details: Option<&Known>,
) -> Value {
    let known = details.cloned().unwrap_or_default();
    json!({
        "state": state,
        "reason": reason,
        "compatibility": compat(known.compatibility.as_deref()),
        "warning": known.warning,
        "approval": settings.approval.as_str(),
        "appVersion": known.app_version,
        "runtimeVersion": known.runtime_version,
        "lcuVersion": known.lcu_version,
        "agents": known.agents,
    })
}

/// The `computerUse` object of the desktop state, plus what to remember for later.
pub(crate) fn computer_use_state(inputs: &Inputs) -> (Value, Option<Known>) {
    let settings = inputs.settings;
    let known = settings.known.as_ref();
    match inputs.app {
        None => {
            return (
                state_object(
                    "preparing",
                    Some("Checking the ChatGPT app."),
                    settings,
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
                    settings,
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
                    settings,
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
                state_object("preparing", Some(&reason), settings, known),
                None,
            );
        }
        Some(Status::Failed { reason, .. }) => {
            return (state_object("failed", Some(reason), settings, known), None)
        }
        Some(Status::Ready { .. }) => {}
    }
    if !inputs.vm_running {
        return match known.filter(|known| matches!(known.state.as_str(), "ready" | "failed")) {
            Some(known) => {
                let reason = (known.state == "failed").then(|| reason_text("setup-failed"));
                (
                    state_object(&known.state, reason, settings, Some(known)),
                    None,
                )
            }
            None => (
                state_object(
                    "unavailable",
                    Some("Start the sandbox to set up computer use."),
                    settings,
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
                settings,
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
    // The guest shows what it applied; a lag behind the user's choice is reported.
    let applied_revision = guest
        .get("approvalRevision")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let applied = text("approval").as_deref().and_then(Approval::parse);
    let applied_owner = text("approvalOwner");
    let approval_pending = applied_revision < settings.revision
        || applied.is_some_and(|applied| applied != settings.approval)
        // The guest still holds another computer's choice (an import or transfer).
        || (!settings.owner.is_empty() && applied_owner.as_deref() != Some(&settings.owner));
    let (state, reason): (&str, Option<String>) = match details.state.as_str() {
        "ready" if approval_pending && inputs.approval_failed => {
            ("failed", Some(reason_text("approval-failed").into()))
        }
        "ready" if approval_pending => ("installing", Some("Applying approval change…".into())),
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
    let remembered = (matches!(state, "ready" | "failed") && !approval_pending).then(|| Known {
        state: state.into(),
        ..details.clone()
    });
    (
        state_object(state, reason.as_deref(), settings, Some(&details)),
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
        approval_failed: apply_failed(machine.id(), current.revision),
    });
    if let Some(known) = remembered {
        remember(paths, machine.id(), known);
    }
    Some(state)
}

// -------------------------------------------------------- commands

/// Runs setup (or re-runs it for agents installed later) in a running VM and returns
/// the helper's status.
pub(crate) fn setup_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    force: bool,
) -> Result<Value, RuntimeError> {
    let policy = sync_policy(paths, machine.id())?;
    let result = sync_now(runner, paths, machine.name(), &policy, force);
    record_apply(machine.id(), policy.policy.revision, result.is_ok());
    result
}

/// Stores the VM's approval mode and, when it runs, applies it. A stopped VM
/// picks it up at its next boot.
pub(crate) fn apply_approval_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
    approval: Approval,
    running: bool,
) -> Result<(), RuntimeError> {
    let revision = set_approval(paths, machine.id(), approval)?;
    if running {
        let policy = SyncPolicy {
            policy: Policy { approval, revision },
            owner: owner(paths)?,
        };
        let result = sync_now(runner, paths, machine.name(), &policy, false);
        record_apply(machine.id(), revision, result.is_ok());
        result?;
    }
    Ok(())
}

/// Prepares the shared folder and the status cache at app start, then downloads the
/// pinned ChatGPT app in the background when it is not published yet.
pub(crate) fn install(app: &AppHandle) {
    let Ok(root) = chatgpt_app::storage_root(app) else {
        return;
    };
    // Cheap (two directories), and a VM created right after launch needs it.
    match chatgpt_app::ensure_published_dir(&root) {
        Ok(dir) => set_published_dir(dir),
        Err(error) => eprintln!("ChatGPT app folder unavailable: {}", error.message),
    }
    // Verifying the app tree the first time reads every byte (seconds): off the main thread.
    let app = app.clone();
    std::thread::spawn(move || chatgpt_app::start_automatic(&app));
}

#[cfg(test)]
mod tests;
