//! Silo's durable names and lifecycle intent for upstream MicroSandbox snapshots.
//! Snapshot data and its reference graph remain owned by MicroSandbox.
use super::*;
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Checkpoint {
    pub(super) id: String,
    /// Native immutable member. Older records used `id` for both identities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_id: Option<String>,
    pub(super) name: String,
    pub(super) created_at: u64,
    pub(super) scope: String,
    pub(super) reason: String,
}

impl Checkpoint {
    fn native_id(&self) -> &str {
        self.native_id.as_deref().unwrap_or(&self.id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PendingRestore {
    pub(super) checkpoint_id: String,
    pub(super) source_workspace: String,
    pub(super) state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Operation {
    pub(super) kind: String,
    pub(super) status: String,
    pub(super) stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreJournal {
    target_checkpoint_id: String,
    recovery_checkpoint: Checkpoint,
    prior_running: bool,
    phase: String,
}

#[derive(Default, Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    version: u8,
    pub(super) checkpoints: Vec<Checkpoint>,
    /// The native MicroSandbox group containing this workspace's lineage.
    /// It is absent until the workspace first captures a checkpoint or backup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) snapshot_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inflight_checkpoint: Option<Checkpoint>,
    #[serde(default)]
    restore_attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) desired_network_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_journal: Option<RestoreJournal>,
    pub(super) pending_checkpoint_restore: Option<PendingRestore>,
    pub(super) checkpoint_operation: Option<Operation>,
}

fn error(message: &str) -> RuntimeError {
    RuntimeError::Unavailable(message.into())
}

fn directory(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("checkpoints")
}

fn path(paths: &RuntimePaths, id: &str) -> PathBuf {
    directory(paths).join(format!("{id}.json"))
}

pub(super) fn load(paths: &RuntimePaths, id: &str) -> Result<Record, RuntimeError> {
    uuid::Uuid::parse_str(id).map_err(|_| error("Invalid workspace identity."))?;
    let bytes = match fs::read(path(paths, id)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Record::default()),
        Err(_) => return Err(error("Checkpoint history could not be read.")),
    };
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(error("Checkpoint history is too large; it was preserved."));
    }
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| error("Checkpoint history is invalid; it was preserved."))?;
    if record.version != 1
        || record
            .snapshot_group
            .as_deref()
            .is_some_and(|group| !valid_snapshot_group(group))
        || record.checkpoints.iter().any(|checkpoint| {
            validate_name(&checkpoint.id).is_err()
                || checkpoint.native_id.as_deref().is_some_and(|native_id| !valid_native_id(native_id))
                || !matches!(checkpoint.scope.as_str(), "full" | "disk")
                || !matches!(checkpoint.reason.as_str(), "manual" | "before-restore")
        })
        || !unique_checkpoint_ids(&record.checkpoints)
        || record
            .inflight_checkpoint
            .as_ref()
            .is_some_and(|checkpoint| {
                validate_name(&checkpoint.id).is_err()
                    || checkpoint.native_id.as_deref().is_some_and(|native_id| !valid_native_id(native_id))
            })
        || record.pending_checkpoint_restore.as_ref().is_some_and(|pending| {
            !valid_native_id(&pending.checkpoint_id)
                || !valid_snapshot_group(&pending.source_workspace)
                || !matches!(pending.state.as_str(), "full" | "disk")
        })
        || record
            .restore_attempt_id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(error("Checkpoint history is invalid; it was preserved."));
    }
    Ok(record)
}

fn valid_native_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn unique_checkpoint_ids(checkpoints: &[Checkpoint]) -> bool {
    let mut ids = HashSet::with_capacity(checkpoints.len());
    checkpoints.iter().all(|checkpoint| ids.insert(&checkpoint.id))
}

fn new_checkpoint_id(record: &Record) -> String {
    loop {
        let id = format!("c{}", &uuid::Uuid::new_v4().simple().to_string()[..31]);
        if !record.checkpoints.iter().any(|checkpoint| checkpoint.id == id)
            && record.inflight_checkpoint.as_ref().is_none_or(|checkpoint| checkpoint.id != id)
        {
            return id;
        }
    }
}

fn ensure_pending_runtime_absent(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine_name: &str,
) -> Result<(), RuntimeError> {
    let listed = runner.run(
        paths,
        &["list".into(), "--format".into(), "json".into()],
        READ_TIMEOUT,
    )?;
    let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout)
        .map_err(|_| error("The runtime returned an invalid sandbox list."))?;
    if listed.iter().any(|entry| entry.name == machine_name) {
        return Err(error(
            "A runtime VM exists for this pending restore. Start or recover it before changing checkpoint state.",
        ));
    }
    Ok(())
}

fn valid_snapshot_group(group: &str) -> bool {
    if validate_name(group).is_ok() {
        return true;
    }
    let Some(suffix) = group.strip_prefix("silo-import-") else {
        return false;
    };
    suffix.len() == 32
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Resolve and persist the native group once. Records from the original
/// checkpoint format used the sandbox name as MicroSandbox's default group.
pub(crate) fn ensure_snapshot_group(
    paths: &RuntimePaths,
    id: &str,
    sandbox_name: &str,
) -> Result<String, RuntimeError> {
    let mut record = load(paths, id)?;
    if let Some(group) = record.snapshot_group.as_deref() {
        if !valid_snapshot_group(group) {
            return Err(error(
                "The saved checkpoint group is invalid; it was preserved.",
            ));
        }
        return Ok(group.to_owned());
    }
    if record.version != 0
        && record.pending_checkpoint_restore.is_none()
        && record.checkpoints.is_empty()
        && record.inflight_checkpoint.is_none()
    {
        return Err(error(
            "Saved snapshot history is missing its native group. It was preserved because the original lineage cannot be identified safely.",
        ));
    }
    let group = record
        .pending_checkpoint_restore
        .as_ref()
        .map(|pending| pending.source_workspace.as_str())
        .unwrap_or(sandbox_name)
        .to_owned();
    if !valid_snapshot_group(&group) {
        return Err(error(
            "The checkpoint group is invalid; no snapshot operation was started.",
        ));
    }
    record.snapshot_group = Some(group.clone());
    save(paths, id, &record)?;
    Ok(group)
}

pub(super) fn save(paths: &RuntimePaths, id: &str, record: &Record) -> Result<(), RuntimeError> {
    uuid::Uuid::parse_str(id).map_err(|_| error("Invalid workspace identity."))?;
    let directory = directory(paths);
    fs::create_dir_all(&directory).map_err(|_| error("Checkpoint history could not be saved."))?;
    let mut file = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| error("Checkpoint history could not be saved."))?;
    let mut record = record.clone();
    record.version = 1;
    serde_json::to_writer(&mut file, &record)
        .map_err(|_| error("Checkpoint history could not be encoded."))?;
    file.as_file()
        .sync_all()
        .map_err(|_| error("Checkpoint history could not be synced."))?;
    file.persist(path(paths, id))
        .map_err(|_| error("Checkpoint history could not be saved."))?;
    File::open(&directory)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| error("Checkpoint history could not be synced."))
}

fn machine(paths: &RuntimePaths, id: &str) -> Result<MachineConfiguration, RuntimeError> {
    read_metadata(&paths.metadata)?
        .machines
        .into_iter()
        .find(|machine| machine.is_vm() && machine.id() == id)
        .ok_or_else(|| RuntimeError::Invalid("This workspace is not a local VM.".into()))
}

fn snapshot_ready(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    source: &str,
    checkpoint_id: &str,
    scope: &str,
) -> Result<(), RuntimeError> {
    if snapshot_available(runner, paths, source, checkpoint_id, scope)? {
        Ok(())
    } else {
        Err(error(
            "The checkpoint is absent or incomplete in the runtime. No workspace state was changed.",
        ))
    }
}

/// Whether the runtime lists the member as ready. Errors mean the list itself failed.
fn snapshot_available(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    source: &str,
    checkpoint_id: &str,
    scope: &str,
) -> Result<bool, RuntimeError> {
    let output = runner.run(
        paths,
        &[
            "snapshot".into(),
            "list".into(),
            "--format".into(),
            "json".into(),
        ],
        READ_TIMEOUT,
    )?;
    let entries: Vec<Value> = serde_json::from_str(&output.stdout)
        .map_err(|_| error("The runtime returned an invalid checkpoint list."))?;
    // A full snapshot contains the disks too, so it also satisfies a disk-only restore
    // (for example an imported checkpoint export, which always restores disks only).
    let scope_matches = |entry: &Value| entry["scope"] == scope || (scope == "disk" && entry["scope"] == "full");
    Ok(entries.iter().any(|entry| {
        entry["group"] == source
            && entry["name"] == checkpoint_id
            && scope_matches(entry)
            && entry["availability"] == "ready"
    }))
}

fn verify_snapshot(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    source: &str,
    checkpoint: &Checkpoint,
) -> Result<(), RuntimeError> {
    snapshot_ready(runner, paths, source, checkpoint.native_id(), &checkpoint.scope)?;
    runner.run(
        paths,
        &[
            "snapshot".into(),
            "verify".into(),
            format!("{source}:{}", checkpoint.native_id()),
        ],
        Duration::from_secs(900),
    )?;
    Ok(())
}

fn current_network_args(config: &Value) -> Result<Vec<String>, RuntimeError> {
    let policy = config.pointer("/network/policy").ok_or_else(|| {
        error("The current network policy is unavailable. The checkpoint was not started.")
    })?;
    let mut args = Vec::new();
    for (key, flag) in [
        ("default_egress", "--net-default-egress"),
        ("default_ingress", "--net-default-ingress"),
    ] {
        let value = policy[key]
            .as_str()
            .filter(|value| matches!(*value, "allow" | "deny"))
            .ok_or_else(|| {
                error("The current network policy is unsupported. The checkpoint was not started.")
            })?;
        args.extend([flag.into(), value.into()]);
    }
    let rules = policy["rules"].as_array().ok_or_else(|| {
        error("The current network rules are unavailable. The checkpoint was not started.")
    })?;
    if rules.len() > 128 {
        return Err(error("The current network policy has too many rules."));
    }
    for rule in rules {
        let action = rule["action"]
            .as_str()
            .filter(|value| matches!(*value, "allow" | "deny"))
            .ok_or_else(|| error("A current network rule is unsupported."))?;
        let direction = rule["direction"]
            .as_str()
            .filter(|value| matches!(*value, "ingress" | "egress"))
            .ok_or_else(|| error("A current network rule is unsupported."))?;
        let group = rule
            .pointer("/destination/group")
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_lowercase())
            })
            .ok_or_else(|| error("A current network destination is unsupported."))?;
        let protocols = rule["protocols"]
            .as_array()
            .ok_or_else(|| error("A current network protocol is unsupported."))?;
        let ports = rule["ports"]
            .as_array()
            .ok_or_else(|| error("A current network port range is unsupported."))?;
        if action == "allow"
            && direction == "egress"
            && group == "host"
            && ports.len() == 1
            && ports[0]["start"] == 53
            && ports[0]["end"] == 53
            && protocols.len() == 2
            && protocols.iter().any(|value| value == "tcp")
            && protocols.iter().any(|value| value == "udp")
        {
            args.extend(["--net-rule".into(), "allow@dns".into()]);
            continue;
        }
        if action == "allow"
            && direction == "egress"
            && group == "public"
            && ports.is_empty()
            && protocols.is_empty()
        {
            args.extend(["--net-rule".into(), "allow@public".into()]);
            continue;
        }
        if ports.len() > 32 || protocols.len() > 3 || (!ports.is_empty() && protocols.is_empty()) {
            return Err(error("A current network rule is unsupported."));
        }
        if protocols.len() > 1 || ports.len() > 1 {
            return Err(error(
                "A current network rule cannot be reproduced exactly.",
            ));
        }
        let protocol_values: Vec<Option<&str>> = if protocols.is_empty() {
            vec![None]
        } else {
            protocols
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| matches!(*value, "tcp" | "udp"))
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| error("A current network protocol is unsupported."))?
                .into_iter()
                .map(Some)
                .collect()
        };
        let port_values: Vec<Option<String>> = if ports.is_empty() {
            vec![None]
        } else {
            ports
                .iter()
                .map(|port| {
                    let start = port["start"]
                        .as_u64()
                        .filter(|value| (1..=65535).contains(value))?;
                    let end = port["end"]
                        .as_u64()
                        .filter(|value| (start..=65535).contains(value))?;
                    Some(Some(if start == end {
                        start.to_string()
                    } else {
                        format!("{start}-{end}")
                    }))
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| error("A current network port range is unsupported."))?
        };
        for protocol in &protocol_values {
            for port in &port_values {
                let mut token = format!("{action}:{direction}@{group}");
                if let Some(protocol) = protocol {
                    token.push_str(&format!(":{protocol}"));
                }
                if let Some(port) = port {
                    token.push_str(&format!(":{port}"));
                }
                args.extend(["--net-rule".into(), token]);
            }
        }
    }
    Ok(args)
}

fn capture_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    id: &str,
    display_name: &str,
    reason: &str,
) -> Result<(), RuntimeError> {
    let label = display_name.trim();
    if label.is_empty() || label.chars().count() > 80 || label.chars().any(char::is_control) {
        return Err(RuntimeError::Invalid(
            "Checkpoint name must contain 1 to 80 printable characters.".into(),
        ));
    }
    let machine = machine(paths, id)?;
    let mut record = load(paths, id)?;
    if let Some(pending) = record.pending_checkpoint_restore.clone() {
        if record.restore_journal.is_some() {
            return Err(error(
                "A Restore recovery is unfinished. Resolve it before creating a checkpoint.",
            ));
        }
        let snapshot_group = ensure_snapshot_group(paths, id, machine.name())?;
        record = load(paths, id)?;
        if pending.source_workspace != snapshot_group
            || !valid_native_id(&pending.checkpoint_id)
            || !matches!(pending.state.as_str(), "full" | "disk")
        {
            return Err(error(
                "The pending checkpoint reference is invalid. It was preserved.",
            ));
        }
        ensure_pending_runtime_absent(runner, paths, machine.name())?;
        snapshot_ready(
            runner,
            paths,
            &snapshot_group,
            &pending.checkpoint_id,
            &pending.state,
        )?;
        let checkpoint = Checkpoint {
            id: new_checkpoint_id(&record),
            native_id: Some(pending.checkpoint_id),
            name: label.into(),
            created_at: activity_timestamp(),
            scope: pending.state,
            reason: reason.into(),
        };
        record.checkpoints.insert(0, checkpoint);
        record.checkpoint_operation = None;
        return save(paths, id, &record);
    }
    ensure_no_unfinished_restore(&record, "creating another checkpoint")?;
    let inspected = inspect_workspace(runner, paths, machine.name())?;
    ensure_managed(&inspected)?;
    if inspected
        .config
        .pointer("/labels/silo.machine-id")
        .and_then(Value::as_str)
        != Some(id)
    {
        return Err(error(
            "The workspace runtime identity changed. No checkpoint was made.",
        ));
    }
    let scope = match inspected.status.as_str() {
        "Running" => "full",
        "Created" | "Stopped" => "disk",
        _ => {
            return Err(RuntimeError::Invalid(
                "Wait until the workspace is running or stopped before creating a checkpoint."
                    .into(),
            ));
        }
    };
    // The old external RawDiskImage mount is excluded by upstream snapshots.
    // Conversion to an owned volume is required before a checkpoint is useful.
    let owned_workspace = inspected
        .config
        .get("mounts")
        .and_then(Value::as_array)
        .is_some_and(|mounts| {
            let workspace: Vec<_> = mounts
                .iter()
                .filter(|mount| mount.get("guest").and_then(Value::as_str) == Some(WORKSPACE_MOUNT))
                .collect();
            workspace.len() == 1
                && workspace[0].get("type").and_then(Value::as_str) == Some("Owned")
                && workspace[0]
                    .pointer("/storage/kind")
                    .and_then(Value::as_str)
                    == Some("disk")
        });
    if !owned_workspace {
        return Err(error(
            "This VM still uses the old workspace disk. Finish runtime migration before creating a checkpoint.",
        ));
    }
    let snapshot_group = ensure_snapshot_group(paths, id, machine.name())?;
    record.snapshot_group = Some(snapshot_group.clone());
    if let Some(interrupted) = record.inflight_checkpoint.clone() {
        // Keep the interrupted entry while the runtime cannot answer; drop it only when
        // the list succeeds and the member is absent or incomplete.
        if snapshot_available(
            runner,
            paths,
            &snapshot_group,
            &interrupted.id,
            &interrupted.scope,
        )? {
            record.checkpoints.insert(0, interrupted);
        }
        record.inflight_checkpoint = None;
        record.checkpoint_operation = None;
        save(paths, id, &record)?;
    }
    let checkpoint_id = new_checkpoint_id(&record);
    let new_checkpoint = Checkpoint {
        id: checkpoint_id.clone(),
        native_id: None,
        name: label.into(),
        created_at: activity_timestamp(),
        scope: scope.into(),
        reason: reason.into(),
    };
    record.inflight_checkpoint = Some(new_checkpoint.clone());
    record.checkpoint_operation = Some(Operation {
        kind: "capture".into(),
        status: "running".into(),
        stage: "Capturing VM state".into(),
        error: None,
    });
    save(paths, id, &record)?;
    let mut args = vec![
        "snapshot".into(),
        "create".into(),
        checkpoint_id.clone(),
        "--from-sandbox".into(),
        machine.name().into(),
        "--group".into(),
        snapshot_group.clone(),
    ];
    if scope == "full" {
        args.extend(["--full".into(), "--guest-flush".into(), "required".into()]);
    }
    args.push("--integrity".into());
    let result = runner.run(paths, &args, Duration::from_secs(900));
    match result {
        Ok(_) => {
            if let Err(failure) =
                snapshot_ready(runner, paths, &snapshot_group, &checkpoint_id, scope)
            {
                record.checkpoint_operation = Some(Operation {
                    kind: "capture".into(),
                    status: "failed".into(),
                    stage: "Verification failed".into(),
                    error: Some(failure.to_string()),
                });
                return Err(save_failure(paths, id, &record, failure));
            }
            record.checkpoints.insert(0, new_checkpoint);
            record.inflight_checkpoint = None;
            record.checkpoint_operation = None;
            save(paths, id, &record)
        }
        Err(failure) => {
            record.checkpoint_operation = Some(Operation {
                kind: "capture".into(),
                status: "failed".into(),
                stage: "Checkpoint failed".into(),
                error: Some(failure.to_string()),
            });
            Err(save_failure(paths, id, &record, failure))
        }
    }
}

fn ensure_no_unfinished_restore(record: &Record, action: &str) -> Result<(), RuntimeError> {
    if record.restore_journal.is_some() {
        return Err(error(&format!(
            "Finish the pending Restore before {action}."
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn create_checkpoint(
    app: AppHandle,
    workspace_id: String,
    name: String,
) -> Result<ApplicationSource, String> {
    crate::runtime_migration::ensure_ready(&app)?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&worker_app)?;
        // Capture touches only this VM's own snapshot store and per-VM checkpoint
        // record, not the shared inventory, so it is ordered per VM by stable id.
        let vm_name = machine(&paths, &workspace_id)
            .map_err(|error| error.to_string())?
            .name()
            .to_owned();
        let guard = OPERATIONS
            .kind(super::operation_gate::OperationKind::CheckpointCapture)
            .vm(&workspace_id, &vm_name, "Creating checkpoint")
            .map_err(|error| error.to_string())?;
        // Checkpoint capture is cancellable and expected to finish within 15 minutes.
        guard.allow_cancel();
        guard.expect_within(std::time::Duration::from_secs(15 * 60));
        let _guard = guard;
        shutdown::ensure_accepting_operations()?;
        let _ = worker_app.emit("silo://application-state-changed", ());
        let result = capture_with(&ProcessRunner, &paths, &workspace_id, &name, "manual")
            .and_then(|_| read_application_state_with(&ProcessRunner, &paths));
        let _ = worker_app.emit("silo://application-state-changed", ());
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Checkpoint worker failed.".to_string())?
}

pub(super) fn is_pending(paths: &RuntimePaths, id: &str) -> Result<bool, RuntimeError> {
    Ok(load(paths, id)?.pending_checkpoint_restore.is_some())
}
pub(super) fn needs_explicit_start(paths: &RuntimePaths, id: &str) -> Result<bool, RuntimeError> {
    let record = load(paths, id)?;
    Ok(record.pending_checkpoint_restore.is_some() || record.restore_journal.is_some())
}

pub(super) fn pending_view(
    paths: &RuntimePaths,
    id: &str,
    runtime_exists: bool,
) -> Result<bool, RuntimeError> {
    let record = load(paths, id)?;
    // Once a restore attempt has created its runtime VM, the workspace is present: it is
    // read from the runtime (with its pending restore still exposed for attention) so the
    // configured and listed sandboxes keep matching, and deletion removes that VM.
    Ok((record.pending_checkpoint_restore.is_some()
        && !(runtime_exists && record.restore_attempted))
        || (!runtime_exists
            && record
                .restore_journal
                .as_ref()
                .is_some_and(|journal| journal.phase == "secured")))
}

pub(super) fn view_pending(record: &Record, name: &str) -> Option<PendingRestore> {
    record.pending_checkpoint_restore.clone().or_else(|| {
        let journal = record
            .restore_journal
            .as_ref()
            .filter(|journal| journal.phase == "secured")?;
        let target = record
            .checkpoints
            .iter()
            .find(|checkpoint| checkpoint.id == journal.target_checkpoint_id)?;
        Some(PendingRestore {
            checkpoint_id: target.native_id().to_owned(),
            source_workspace: record.snapshot_group.as_deref().unwrap_or(name).into(),
            state: target.scope.clone(),
        })
    })
}

pub(crate) fn forget_removed(paths: &RuntimePaths, id: &str) -> Result<(), RuntimeError> {
    let target = path(paths, id);
    match fs::remove_file(target) {
        Ok(()) => File::open(directory(paths))
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("Removed checkpoint history could not be synced.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(error("Removed checkpoint history could not be cleared.")),
    }
}

pub(super) fn pending_workspace(
    machine: MachineConfiguration,
) -> Result<ApplicationWorkspace, RuntimeError> {
    if !machine.is_vm() {
        return Err(error("A checkpoint fork must be a local VM."));
    }
    Ok(ApplicationWorkspace {
        machine,
        purpose: "Local MicroSandbox".into(),
        state: WorkspaceState::Stopped,
        state_detail: "Ready to start from checkpoint".into(),
        can_dismiss_error: false,
        lifecycle_failure: None,
        attention: None,
        freshness: Freshness::Fresh,
        settling: false,
        host: "127.0.0.1".into(),
        repositories: Vec::new(),
        files: Vec::new(),
        ports: Vec::new(),
        logs: Vec::new(),
        github_repositories: Vec::new(),
        secret_names: Vec::new(),
        checkpoints: Vec::new(),
        pending_checkpoint_restore: None,
        checkpoint_operation: None,
    })
}

/// True for the exact `c` + 31 hex-digit form produced by `new_checkpoint_id`.
fn is_checkpoint_native_id(id: &str) -> bool {
    id.len() == 32
        && id.as_bytes()[0] == b'c'
        && id[1..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Resolve a stored checkpoint into the MicroSandbox lineage selector a portable
/// export needs. The checkpoint is addressed by its public Silo id in this
/// workspace's record; the returned member is MicroSandbox's immutable name.
/// Returns `(snapshot_group, native_member, scope, display_name)`.
pub(crate) fn export_source(
    paths: &RuntimePaths,
    workspace_id: &str,
    checkpoint_id: &str,
) -> Result<(String, String, String, String), RuntimeError> {
    let machine = machine(paths, workspace_id)?;
    let record = load(paths, workspace_id)?;
    if record.restore_journal.is_some() {
        return Err(error(
            "Finish the pending Restore before exporting a checkpoint.",
        ));
    }
    if record
        .inflight_checkpoint
        .as_ref()
        .is_some_and(|checkpoint| checkpoint.id == checkpoint_id)
    {
        return Err(error(
            "That checkpoint is still being captured. Export it once capture finishes.",
        ));
    }
    let checkpoint = record
        .checkpoints
        .iter()
        .find(|checkpoint| checkpoint.id == checkpoint_id)
        .ok_or_else(|| RuntimeError::Invalid("The selected checkpoint no longer exists.".into()))?
        .clone();
    // Resolve (and migrate, for original-format records) the immutable native
    // lineage group that holds this checkpoint's member.
    let snapshot_group = ensure_snapshot_group(paths, workspace_id, machine.name())?;
    Ok((
        snapshot_group,
        checkpoint.native_id().to_owned(),
        checkpoint.scope.clone(),
        checkpoint.name.clone(),
    ))
}

/// Record an archive snapshot as a new stopped workspace. Snapshot loading
/// only installs immutable data; activation is deliberately deferred to the
/// common explicit-start path.
pub(crate) fn import_pending_restore(
    paths: &RuntimePaths,
    workspace_id: &str,
    source_group: &str,
    member: &str,
) -> Result<(), RuntimeError> {
    // These are MicroSandbox snapshot selectors, not sandbox names. Require
    // the exact forms produced by Silo's v3 export/import before saving intent.
    // The member is either a state export's `silo-backup-<n>-<n>-<n>` name or,
    // for a checkpoint export, that checkpoint's `c`+31-hex native id.
    let group_suffix = source_group.strip_prefix("silo-import-").unwrap_or("");
    let member_suffix = member.strip_prefix("silo-backup-").unwrap_or("");
    let member_parts: Vec<_> = member_suffix.split('-').collect();
    let backup_member = member.starts_with("silo-backup-")
        && member_parts.len() == 3
        && member_parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    if source_group.len() != 44
        || group_suffix.len() != 32
        || !group_suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || member.len() > 128
        || !(backup_member || is_checkpoint_native_id(member))
    {
        return Err(RuntimeError::Invalid(
            "Imported snapshot reference is invalid.".into(),
        ));
    }
    let mut record = Record::default();
    record.snapshot_group = Some(source_group.to_owned());
    record.pending_checkpoint_restore = Some(PendingRestore {
        checkpoint_id: member.to_owned(),
        source_workspace: source_group.to_owned(),
        state: "disk".into(),
    });
    // Imported policy and credentials are archive input and carry no authority.
    // Start will resolve current host-side assignments against this deny policy.
    record.desired_network_policy = Some(serde_json::json!({
        "default_egress": "deny",
        "default_ingress": "deny",
        "rules": []
    }));
    save(paths, workspace_id, &record)
}

/// Capture a checkpoint through the production capture path and return its public
/// Silo id. Used by opt-in live tests to exercise real checkpoint exports.
#[cfg(test)]
pub(crate) fn capture_for_test(
    paths: &RuntimePaths,
    workspace_id: &str,
    name: &str,
) -> Result<String, RuntimeError> {
    capture_with(&ProcessRunner, paths, workspace_id, name, "manual")?;
    load(paths, workspace_id)?
        .checkpoints
        .first()
        .map(|checkpoint| checkpoint.id.clone())
        .ok_or_else(|| error("The captured checkpoint was not recorded."))
}

fn running_child_matches(
    inspected: &InspectedSandbox,
    id: &str,
    attempt_id: &str,
    material: &secrets_runtime::Material,
    policy: &Value,
) -> bool {
    inspected.status == "Running"
        && inspected
            .config
            .pointer("/labels/silo.managed")
            .and_then(Value::as_str)
            == Some("true")
        && inspected
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            == Some(id)
        && inspected
            .config
            .pointer("/labels/silo.restore-attempt")
            .and_then(Value::as_str)
            == Some(attempt_id)
        && inspected.config.pointer("/network/policy") == Some(policy)
        && secrets_runtime::verify_config(&inspected.config, material)
        && inspected
            .config
            .pointer("/network/secrets/secrets")
            .and_then(Value::as_array)
            .is_some_and(|secrets| {
                secrets.iter().any(|secret| {
                    secret["env_var"] == "SILO_GITHUB"
                        && secret["value"] == ""
                        && secret["source"]["kind"] == "env"
                        && secret["source"]["var"] == "SILO_GITHUB"
                })
            })
}

pub(super) fn start_pending(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    let mut record = load(paths, machine.id())?;
    let lineage_group = ensure_snapshot_group(paths, machine.id(), machine.name())?;
    record.snapshot_group = Some(lineage_group.clone());
    if record.pending_checkpoint_restore.is_none()
        && record
            .restore_journal
            .as_ref()
            .is_some_and(|journal| journal.phase == "secured")
    {
        let listed = runner.run(
            paths,
            &["list".into(), "--format".into(), "json".into()],
            READ_TIMEOUT,
        )?;
        let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout)
            .map_err(|_| error("The runtime returned an invalid sandbox list."))?;
        if listed.iter().any(|entry| entry.name == machine.name()) {
            return Err(error(
                "The original VM is still present. Retry Restore before starting its replacement.",
            ));
        }
        let journal = record.restore_journal.clone().unwrap();
        let target = record
            .checkpoints
            .iter()
            .find(|checkpoint| checkpoint.id == journal.target_checkpoint_id)
            .ok_or_else(|| error("The selected checkpoint was lost from recovery history."))?;
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: target.native_id().to_owned(),
            source_workspace: lineage_group.clone(),
            state: target.scope.clone(),
        });
        record.restore_journal = None;
        record.checkpoint_operation = None;
        save(paths, machine.id(), &record)?;
    }
    let pending = record.pending_checkpoint_restore.clone().ok_or_else(|| {
        RuntimeError::Invalid("This workspace has no pending checkpoint restore.".into())
    })?;
    if !matches!(pending.state.as_str(), "full" | "disk") {
        return Err(error(
            "The pending checkpoint has an unsupported capture scope.",
        ));
    }
    if pending.source_workspace != lineage_group {
        return Err(error(
            "The pending checkpoint group does not match saved lineage metadata. The checkpoint was preserved.",
        ));
    }
    let policy = record.desired_network_policy.clone().ok_or_else(|| {
        error("The fork's desired network policy is missing. The checkpoint was preserved.")
    })?;
    let network_args = current_network_args(&serde_json::json!({"network":{"policy":policy}}))?;
    let material =
        crate::secrets::runtime_material(machine.name()).map_err(RuntimeError::Unavailable)?;
    secrets_runtime::validate_material(&material).map_err(RuntimeError::Invalid)?;
    snapshot_ready(
        runner,
        paths,
        &pending.source_workspace,
        &pending.checkpoint_id,
        &pending.state,
    )?;
    let listed = runner.run(
        paths,
        &["list".into(), "--format".into(), "json".into()],
        READ_TIMEOUT,
    )?;
    let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout)
        .map_err(|_| error("The runtime returned an invalid sandbox list."))?;
    if listed.iter().any(|entry| entry.name == machine.name()) {
        if !record.restore_attempted {
            return Err(error(
                "A runtime sandbox already uses this fork's name. No restore was attempted.",
            ));
        }
        let observed = inspect_workspace(runner, paths, machine.name())?;
        let attempt_id = record.restore_attempt_id.as_deref().ok_or_else(|| {
            error("The previous restore attempt has no saved identity. It was preserved.")
        })?;
        if running_child_matches(&observed, machine.id(), attempt_id, &material, &policy) {
            record.pending_checkpoint_restore = None;
            record.checkpoint_operation = None;
            record.restore_attempted = false;
            record.restore_attempt_id = None;
            save(paths, machine.id(), &record)?;
            return Ok(());
        }
        if observed
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(machine.id())
            || observed
                .config
                .pointer("/labels/silo.managed")
                .and_then(Value::as_str)
                != Some("true")
            || observed
                .config
                .pointer("/labels/silo.restore-attempt")
                .and_then(Value::as_str)
                != Some(attempt_id)
            || !matches!(observed.status.as_str(), "Created" | "Stopped" | "Crashed")
        {
            return Err(error(
                "A previous restore attempt has unverified runtime state. It was preserved for inspection.",
            ));
        }
        runner.run(
            paths,
            &["remove".into(), "--quiet".into(), machine.name().into()],
            STOP_TIMEOUT,
        )?;
    }
    record.restore_attempted = true;
    let attempt_id = uuid::Uuid::new_v4().to_string();
    record.restore_attempt_id = Some(attempt_id.clone());
    record.checkpoint_operation = Some(Operation {
        kind: "fork".into(),
        status: "running".into(),
        stage: "Starting from checkpoint".into(),
        error: None,
    });
    save(paths, machine.id(), &record)?;
    let mut args = vec![
        "restore".into(),
        format!("{}:{}", pending.source_workspace, pending.checkpoint_id),
        "--name".into(),
        machine.name().into(),
    ];
    // A disk snapshot cold-boots by default. MicroSandbox's --disk-only
    // selects the disk from a *full* checkpoint and rejects file/disk captures.
    if pending.state == "full" {
        args.push("--forked".into());
    } else if let MachineConfiguration::Vm {
        cpus, memory_gib, ..
    } = machine
    {
        // Disk restore starts a new VM and otherwise uses the runtime's 1 CPU / 512 MiB
        // defaults. Preserve the user's saved Silo resources on imported cold boots.
        args.extend([
            "--cpus".into(),
            cpus.to_string(),
            "--memory".into(),
            format!("{memory_gib}G"),
        ]);
    }
    for label in [
        MANAGED_LABEL.to_string(),
        format!("silo.machine-id={}", machine.id()),
        format!("silo.restore-attempt={attempt_id}"),
        crate::working_account::UNIFIED_LABEL.into(),
        "silo.github-protocol=1".into(),
    ] {
        args.extend(["--label".into(), label]);
    }
    args.extend([
        "--secret".into(),
        super::secrets_runtime::SILO_GITHUB_SECRET_SPEC.into(),
    ]);
    for (name, _, domains) in &material {
        args.extend([
            "--secret".into(),
            format!("{name}:passthrough=*@{}", domains.join(",")),
        ]);
    }
    args.extend(network_args);
    let result = runner.run(paths, &args, Duration::from_secs(900))
        .and_then(|_| inspect_workspace(runner, paths, machine.name()))
        .and_then(|observed| if running_child_matches(&observed, machine.id(), &attempt_id, &material, &policy) {
            Ok(observed)
        } else { Err(error("The restored VM did not reach a verified running state. Its checkpoint was preserved.")) });
    match result {
        Ok(observed) => {
            record.pending_checkpoint_restore = None;
            record.restore_attempted = false;
            record.restore_attempt_id = None;
            record.checkpoint_operation = None;
            save(paths, machine.id(), &record)?;
            let revision = crate::secrets::workspace_revision(machine.name())
                .map_err(RuntimeError::Unavailable)?;
            crate::secrets::workspace_started(machine.name(), &revision)
                .map_err(RuntimeError::Unavailable)?;
            crate::network::reconcile_started(paths, machine.name());
            crate::ssh_access::reconcile(paths);
            // Record the verified storage runtime like an ordinary Start, so the Storage
            // panel and automatic reclamation treat the restored VM as current.
            super::storage::after_start(runner, paths, &observed);
            Ok(())
        }
        Err(failure) => {
            record.checkpoint_operation = Some(Operation {
                kind: "fork".into(),
                status: "failed".into(),
                stage: "Start failed".into(),
                error: Some(failure.to_string()),
            });
            Err(save_failure(paths, machine.id(), &record, failure))
        }
    }
}

fn fork_source_policy(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    source: &MachineConfiguration,
    record: &Record,
) -> Result<Value, RuntimeError> {
    if view_pending(record, source.name()).is_some() {
        let listed = runner.run(
            paths,
            &["list".into(), "--format".into(), "json".into()],
            READ_TIMEOUT,
        )?;
        let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout)
            .map_err(|_| error("The runtime returned an invalid sandbox list."))?;
        if !listed.iter().any(|entry| entry.name == source.name()) {
            let policy = record.desired_network_policy.clone().ok_or_else(|| {
                error("The source network policy is missing. No fork was created.")
            })?;
            current_network_args(&serde_json::json!({"network":{"policy":policy}}))?;
            return Ok(policy);
        }
    }
    let source_runtime = inspect_workspace(runner, paths, source.name())?;
    ensure_managed(&source_runtime)?;
    if source_runtime
        .config
        .pointer("/labels/silo.machine-id")
        .and_then(Value::as_str)
        != Some(source.id())
    {
        return Err(error(
            "The source workspace identity changed. No fork was created.",
        ));
    }
    current_network_args(&source_runtime.config)?;
    source_runtime
        .config
        .pointer("/network/policy")
        .cloned()
        .ok_or_else(|| error("The source network policy is missing."))
}

fn pending_current_fork_point(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine_name: &str,
    record: &Record,
    snapshot_group: &str,
) -> Result<Option<PendingRestore>, RuntimeError> {
    let Some(pending) = record.pending_checkpoint_restore.clone() else {
        return Ok(None);
    };
    if record.restore_journal.is_some()
        || pending.source_workspace != snapshot_group
        || !valid_native_id(&pending.checkpoint_id)
        || !matches!(pending.state.as_str(), "full" | "disk")
    {
        return Err(error(
            "The pending checkpoint reference is invalid or has unfinished recovery. It was preserved.",
        ));
    }
    ensure_pending_runtime_absent(runner, paths, machine_name)?;
    snapshot_ready(
        runner,
        paths,
        snapshot_group,
        &pending.checkpoint_id,
        &pending.state,
    )?;
    Ok(Some(pending))
}

fn fork_with(
    app: &AppHandle,
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    workspace_id: &str,
    checkpoint_id: Option<&str>,
    new_name: &str,
) -> Result<(), RuntimeError> {
    validate_name(new_name)?;
    let mut metadata = read_metadata(&paths.metadata)?;
    let source = metadata
        .machines
        .iter()
        .find(|machine| machine.is_vm() && machine.id() == workspace_id)
        .ok_or_else(|| RuntimeError::Invalid("The source workspace is not a local VM.".into()))?
        .clone();
    let source_record = load(paths, workspace_id)?;
    let snapshot_group = ensure_snapshot_group(paths, workspace_id, source.name())?;
    let pending_current = if checkpoint_id.is_none() {
        pending_current_fork_point(
            runner,
            paths,
            source.name(),
            &source_record,
            &snapshot_group,
        )?
    } else {
        None
    };
    if checkpoint_id.is_none() && pending_current.is_none() {
        ensure_no_unfinished_restore(&source_record, "forking its current state")?;
    }
    let desired_policy = fork_source_policy(runner, paths, &source, &source_record)?;
    if metadata.machines.len() >= MAX_MACHINE_COUNT
        || metadata.machines.iter().any(|m| m.name() == new_name)
    {
        return Err(RuntimeError::Invalid(
            "The fork name is already in use or the workspace limit was reached.".into(),
        ));
    }
    let (selected_id, selected_scope) = if let Some(pending) = pending_current {
        (pending.checkpoint_id, pending.state)
    } else {
        let selected_id = match checkpoint_id {
            Some(id) => id.to_owned(),
            None => {
                capture_with(runner, paths, workspace_id, "Fork point", "manual")?;
                load(paths, workspace_id)?
                    .checkpoints
                    .first()
                    .ok_or_else(|| error("The fork checkpoint was not recorded."))?
                    .id
                    .clone()
            }
        };
        let source_record = load(paths, workspace_id)?;
        let checkpoint = source_record
            .checkpoints
            .iter()
            .find(|c| c.id == selected_id)
            .ok_or_else(|| RuntimeError::Invalid("The selected checkpoint no longer exists.".into()))?;
        snapshot_ready(
            runner,
            paths,
            &snapshot_group,
            checkpoint.native_id(),
            &checkpoint.scope,
        )?;
        (checkpoint.native_id().to_owned(), checkpoint.scope.clone())
    };
    let child_id = uuid::Uuid::new_v4().to_string();
    let mut child = source.clone();
    if let MachineConfiguration::Vm { id, name, .. } = &mut child {
        *id = child_id.clone();
        *name = new_name.into();
    }
    let mut child_record = Record::default();
    child_record.snapshot_group = Some(snapshot_group.clone());
    child_record.pending_checkpoint_restore = Some(PendingRestore {
        checkpoint_id: selected_id,
        source_workspace: snapshot_group,
        state: selected_scope,
    });
    child_record.desired_network_policy = Some(desired_policy);
    save(paths, &child_id, &child_record)?;
    crate::github::fork_assignment(app, source.name(), new_name)
        .map_err(RuntimeError::Unavailable)?;
    if let Err(failure) = crate::secrets::fork_assignments(source.name(), new_name) {
        crate::github::forget_fork_assignment(app, new_name).map_err(RuntimeError::Unavailable)?;
        return Err(RuntimeError::Unavailable(failure));
    }
    metadata.machines.push(child);
    if let Err(failure) = write_metadata(&paths.metadata, &metadata) {
        crate::secrets::workspace_removed(new_name).map_err(RuntimeError::Unavailable)?;
        crate::github::forget_fork_assignment(app, new_name).map_err(RuntimeError::Unavailable)?;
        return Err(failure);
    }
    Ok(())
}

#[tauri::command]
pub async fn fork_checkpoint(
    app: AppHandle,
    workspace_id: String,
    checkpoint_id: Option<String>,
    new_name: String,
) -> Result<ApplicationSource, String> {
    crate::runtime_migration::ensure_ready(&app)?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&worker_app)?;
        // Fork creates a new VM and edits the shared inventory; computer scope.
        let guard = OPERATIONS
            .kind(super::operation_gate::OperationKind::CheckpointFork)
            .computer("Forking checkpoint")
            .map_err(|error| error.to_string())?;
        // Fork is not cancellable; flag it slow after the default window.
        guard.expect_within(std::time::Duration::from_secs(10 * 60));
        let _guard = guard;
        shutdown::ensure_accepting_operations()?;
        let result = fork_with(
            &worker_app,
            &ProcessRunner,
            &paths,
            &workspace_id,
            checkpoint_id.as_deref(),
            &new_name,
        )
        .and_then(|_| read_application_state_with(&ProcessRunner, &paths));
        let _ = worker_app.emit("silo://application-state-changed", ());
        result.map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Checkpoint fork worker failed.".to_string())?
}

/// Persist a failure record without letting a save failure replace the real error.
fn save_failure(
    paths: &RuntimePaths,
    id: &str,
    record: &Record,
    failure: RuntimeError,
) -> RuntimeError {
    if save(paths, id, record).is_ok() {
        return failure;
    }
    let context = " Checkpoint history could not be updated.";
    match failure {
        RuntimeError::Invalid(message) => RuntimeError::Invalid(format!("{message}{context}")),
        RuntimeError::Unavailable(message) => {
            RuntimeError::Unavailable(format!("{message}{context}"))
        }
        RuntimeError::Malformed(message) => RuntimeError::Malformed(format!("{message}{context}")),
        other => other,
    }
}

/// Leave the `capturing` phase after a failure that happened before the recovery
/// checkpoint existed. The original VM is untouched, so the journal is cleared unless
/// the VM stays paused (a retry then continues from the paused VM).
fn abandon_capture(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    workspace_id: &str,
    record: &mut Record,
    vm_name: &str,
    assume_paused: bool,
    failure: RuntimeError,
) -> RuntimeError {
    let paused = inspect_workspace(runner, paths, vm_name)
        .map(|inspected| inspected.status == "Paused")
        .unwrap_or(assume_paused);
    if !paused
        || runner
            .run(paths, &["resume".into(), vm_name.into()], MUTATION_TIMEOUT)
            .is_ok()
    {
        record.restore_journal = None;
    }
    record.checkpoint_operation = Some(Operation {
        kind: "restore".into(),
        status: "failed".into(),
        stage: "Recovery checkpoint failed".into(),
        error: Some(failure.to_string()),
    });
    save_failure(paths, workspace_id, record, failure)
}

fn restore_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    workspace_id: &str,
    checkpoint_id: &str,
) -> Result<(), RuntimeError> {
    restore_steps(runner, paths, workspace_id, checkpoint_id).map_err(|failure| {
        // Every error after the journal save must leave a failed status with the
        // real cause, not a "running" operation later read as an interrupted one.
        let Ok(mut record) = load(paths, workspace_id) else {
            return failure;
        };
        let Some(operation) = record
            .checkpoint_operation
            .as_ref()
            .filter(|operation| operation.kind == "restore" && operation.status == "running")
        else {
            return failure;
        };
        record.checkpoint_operation = Some(Operation {
            kind: "restore".into(),
            status: "failed".into(),
            stage: operation.stage.clone(),
            error: Some(failure.to_string()),
        });
        save_failure(paths, workspace_id, &record, failure)
    })
}

fn restore_steps(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    workspace_id: &str,
    checkpoint_id: &str,
) -> Result<(), RuntimeError> {
    let machine = machine(paths, workspace_id)?;
    let mut record = load(paths, workspace_id)?;
    let lineage_group = ensure_snapshot_group(paths, workspace_id, machine.name())?;
    record.snapshot_group = Some(lineage_group.clone());
    let target = record
        .checkpoints
        .iter()
        .find(|checkpoint| checkpoint.id == checkpoint_id)
        .ok_or_else(|| RuntimeError::Invalid("The selected checkpoint no longer exists.".into()))?
        .clone();
    verify_snapshot(runner, paths, &lineage_group, &target)?;
    if let Some(pending) = record.pending_checkpoint_restore.clone() {
        if record.restore_journal.is_some() {
            return Err(error(
                "A previous Restore recovery is unfinished. The pending checkpoint was preserved.",
            ));
        }
        if pending.source_workspace != lineage_group
            || !valid_native_id(&pending.checkpoint_id)
            || !matches!(pending.state.as_str(), "full" | "disk")
        {
            return Err(error(
                "The pending checkpoint reference is invalid. It was preserved.",
            ));
        }
        ensure_pending_runtime_absent(runner, paths, machine.name())?;
        snapshot_ready(
            runner,
            paths,
            &lineage_group,
            &pending.checkpoint_id,
            &pending.state,
        )?;
        let current = Checkpoint {
            id: new_checkpoint_id(&record),
            native_id: Some(pending.checkpoint_id.clone()),
            name: "Before restore".into(),
            created_at: activity_timestamp(),
            scope: pending.state,
            reason: "before-restore".into(),
        };
        record.checkpoints.insert(0, current);
        let policy = record.desired_network_policy.as_ref().ok_or_else(|| {
            error("The current network policy is missing. The pending checkpoint was preserved.")
        })?;
        current_network_args(&serde_json::json!({"network":{"policy":policy}}))?;
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: target.native_id().to_owned(),
            source_workspace: lineage_group,
            state: target.scope,
        });
        record.restore_attempted = false;
        record.restore_attempt_id = None;
        record.checkpoint_operation = None;
        return save(paths, workspace_id, &record);
    }
    if record
        .restore_journal
        .as_ref()
        .is_some_and(|journal| journal.phase == "secured")
    {
        let listed = runner.run(
            paths,
            &["list".into(), "--format".into(), "json".into()],
            READ_TIMEOUT,
        )?;
        let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout)
            .map_err(|_| error("The runtime returned an invalid sandbox list."))?;
        if !listed.iter().any(|entry| entry.name == machine.name()) {
            record.pending_checkpoint_restore = Some(PendingRestore {
                checkpoint_id: target.native_id().to_owned(),
                source_workspace: lineage_group.clone(),
                state: target.scope,
            });
            record.restore_journal = None;
            record.restore_attempted = false;
            record.restore_attempt_id = None;
            record.checkpoint_operation = None;
            save(paths, workspace_id, &record)?;
            return Ok(());
        }
    }
    let inspected = inspect_workspace(runner, paths, machine.name())?;
    ensure_managed(&inspected)?;
    if inspected
        .config
        .pointer("/labels/silo.machine-id")
        .and_then(Value::as_str)
        != Some(workspace_id)
    {
        return Err(error(
            "The workspace runtime identity changed. No Restore was performed.",
        ));
    }
    let policy = inspected
        .config
        .pointer("/network/policy")
        .ok_or_else(|| error("The current network policy is unavailable."))?
        .clone();
    current_network_args(&inspected.config)?;
    let prior_running = inspected.status == "Running";
    // A retry of an unfinished Restore also accepts a crashed VM: its disks are intact.
    let retrying = record.restore_journal.is_some();
    if !prior_running
        && !matches!(inspected.status.as_str(), "Paused" | "Stopped" | "Created")
        && !(retrying && inspected.status == "Crashed")
    {
        return Err(RuntimeError::Invalid(
            "Wait until the VM is running or stopped before Restore.".into(),
        ));
    }
    if let Some(existing) = &record.restore_journal {
        if existing.target_checkpoint_id != checkpoint_id {
            return Err(RuntimeError::Invalid(
                "A previous Restore is unfinished. Retry the same checkpoint first.".into(),
            ));
        }
    } else {
        let recovery = Checkpoint {
            id: format!("c{}", &uuid::Uuid::new_v4().simple().to_string()[..31]),
            native_id: None,
            name: "Before restore".into(),
            created_at: activity_timestamp(),
            scope: if prior_running { "full" } else { "disk" }.into(),
            reason: "before-restore".into(),
        };
        record.desired_network_policy = Some(policy);
        record.restore_journal = Some(RestoreJournal {
            target_checkpoint_id: checkpoint_id.into(),
            recovery_checkpoint: recovery,
            prior_running,
            phase: "capturing".into(),
        });
        record.checkpoint_operation = Some(Operation {
            kind: "restore".into(),
            status: "running".into(),
            stage: "Creating recovery checkpoint".into(),
            error: None,
        });
        save(paths, workspace_id, &record)?;
    }
    let mut journal = record.restore_journal.clone().unwrap();
    if journal.phase == "capturing" {
        if journal.prior_running
            && matches!(inspected.status.as_str(), "Stopped" | "Created" | "Crashed")
        {
            // The VM stopped before its memory was captured (for example Silo or the
            // host closed mid-capture). Only its disks remain, so secure those instead.
            journal.prior_running = false;
            journal.recovery_checkpoint.scope = "disk".into();
            record.restore_journal = Some(journal.clone());
            save(paths, workspace_id, &record)?;
        }
        if journal.prior_running && inspected.status == "Running" {
            if let Err(failure) = runner.run(
                paths,
                &[
                    "pause".into(),
                    machine.name().into(),
                    "--guest-flush".into(),
                    "required".into(),
                ],
                MUTATION_TIMEOUT,
            ) {
                return Err(abandon_capture(
                    runner,
                    paths,
                    workspace_id,
                    &mut record,
                    machine.name(),
                    false,
                    failure,
                ));
            }
        }
        if journal.prior_running
            && inspect_workspace(runner, paths, machine.name())?.status != "Paused"
        {
            return Err(abandon_capture(
                runner,
                paths,
                workspace_id,
                &mut record,
                machine.name(),
                false,
                error("The VM did not remain paused. No replacement was made."),
            ));
        }
        let mut args = vec![
            "snapshot".into(),
            "create".into(),
            journal.recovery_checkpoint.id.clone(),
            "--from-sandbox".into(),
            machine.name().into(),
            "--group".into(),
            lineage_group.clone(),
        ];
        if journal.prior_running {
            args.extend(["--full".into(), "--guest-flush".into(), "required".into()]);
        }
        args.push("--integrity".into());
        let capture = runner
            .run(paths, &args, Duration::from_secs(900))
            .and_then(|_| {
                verify_snapshot(runner, paths, &lineage_group, &journal.recovery_checkpoint)
            });
        if let Err(failure) = capture {
            return Err(abandon_capture(
                runner,
                paths,
                workspace_id,
                &mut record,
                machine.name(),
                journal.prior_running,
                failure,
            ));
        }
        if !record
            .checkpoints
            .iter()
            .any(|checkpoint| checkpoint.id == journal.recovery_checkpoint.id)
        {
            record
                .checkpoints
                .insert(0, journal.recovery_checkpoint.clone());
        }
        journal.phase = "secured".into();
        record.restore_journal = Some(journal.clone());
        record.checkpoint_operation = Some(Operation {
            kind: "restore".into(),
            status: "running".into(),
            stage: "Replacing workspace generation".into(),
            error: None,
        });
        save(paths, workspace_id, &record)?;
    }
    let current = inspect_workspace(runner, paths, machine.name())?;
    if current.status == "Running" {
        return Err(error(
            "The VM resumed after its recovery checkpoint. Restore was stopped to protect later writes.",
        ));
    }
    if current.status == "Paused" {
        runner.run(
            paths,
            &["stop".into(), "--force".into(), machine.name().into()],
            STOP_TIMEOUT,
        )?;
    }
    let stopped = inspect_workspace(runner, paths, machine.name())?;
    if !matches!(stopped.status.as_str(), "Stopped" | "Created" | "Crashed") {
        return Err(error(
            "The original VM did not stop. Its recovery checkpoint was preserved.",
        ));
    }
    crate::ssh_access::close_workspace(machine.name());
    crate::desktop_viewer::close_workspace(machine.name());
    runner.run(
        paths,
        &["remove".into(), "--quiet".into(), machine.name().into()],
        STOP_TIMEOUT,
    )?;
    record.pending_checkpoint_restore = Some(PendingRestore {
        checkpoint_id: target.native_id().to_owned(),
        source_workspace: lineage_group,
        state: target.scope,
    });
    record.restore_journal = None;
    record.restore_attempted = false;
    record.restore_attempt_id = None;
    record.checkpoint_operation = None;
    save(paths, workspace_id, &record)
}

#[tauri::command]
pub async fn restore_checkpoint(
    app: AppHandle,
    workspace_id: String,
    checkpoint_id: String,
) -> Result<ApplicationSource, String> {
    crate::runtime_migration::ensure_ready(&app)?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&worker_app)?;
        // Restore rewrites only this VM's runtime state and per-VM checkpoint record,
        // not the shared inventory, so it is ordered per VM by stable id.
        let vm_name = machine(&paths, &workspace_id)
            .map_err(|error| error.to_string())?
            .name()
            .to_owned();
        let guard = OPERATIONS
            .kind(super::operation_gate::OperationKind::CheckpointRestore)
            .vm(&workspace_id, &vm_name, "Restoring checkpoint")
            .map_err(|error| error.to_string())?;
        // Restore is deliberately not cancellable; flag it slow after the restore window.
        guard.expect_within(std::time::Duration::from_secs(60 * 60));
        let _guard = guard;
        shutdown::ensure_accepting_operations()?;
        let result = restore_with(&ProcessRunner, &paths, &workspace_id, &checkpoint_id)
            .and_then(|_| read_application_state_with(&ProcessRunner, &paths));
        let _ = worker_app.emit("silo://application-state-changed", ());
        result.map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Checkpoint Restore worker failed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn full_snapshot_satisfies_a_disk_only_restore_but_not_the_reverse() {
        struct Listing(&'static str);
        impl RuntimeRunner for Listing {
            fn run(&self, _: &RuntimePaths, _: &[String], _: Duration) -> Result<CommandOutput, RuntimeError> {
                Ok(CommandOutput {
                    stdout: format!("[{{\"group\":\"g\",\"name\":\"c\",\"scope\":\"{}\",\"availability\":\"ready\"}}]", self.0),
                    stderr: String::new(),
                })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        // An imported checkpoint export: a full snapshot restored disk-only.
        assert!(snapshot_ready(&Listing("full"), &paths, "g", "c", "disk").is_ok());
        assert!(snapshot_ready(&Listing("full"), &paths, "g", "c", "full").is_ok());
        assert!(snapshot_ready(&Listing("disk"), &paths, "g", "c", "disk").is_ok());
        // A disk-only snapshot has no memory, so it can't satisfy a full restore.
        assert!(snapshot_ready(&Listing("disk"), &paths, "g", "c", "full").is_err());
    }
    #[test]
    fn imported_snapshot_intent_accepts_native_selectors_but_rejects_paths() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let group = "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9";
        let member = "silo-backup-0-330418-1790360984903";
        import_pending_restore(&paths, ID, group, member).unwrap();
        let pending = load(&paths, ID)
            .unwrap()
            .pending_checkpoint_restore
            .unwrap();
        assert_eq!(pending.source_workspace, group);
        assert_eq!(
            load(&paths, ID).unwrap().snapshot_group.as_deref(),
            Some(group)
        );
        assert_eq!(pending.checkpoint_id, member);
        assert_eq!(pending.state, "disk");
        for (bad_group, bad_member) in [
            ("../silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9", member),
            (group, "../silo-backup-0-330418-1790360984903"),
            (group, "silo-backup-0:330418-1790360984903"),
            ("silo-import-not-a-uuid", member),
        ] {
            assert!(import_pending_restore(&paths, ID, bad_group, bad_member).is_err());
        }
    }

    #[test]
    fn imported_snapshot_intent_accepts_a_checkpoint_native_member() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let group = "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9";
        // A `c` + 31 hex-digit member, as produced by a checkpoint export.
        let member = "c0123456789abcdef0123456789abcde";
        import_pending_restore(&paths, ID, group, member).unwrap();
        let pending = load(&paths, ID)
            .unwrap()
            .pending_checkpoint_restore
            .unwrap();
        assert_eq!(pending.checkpoint_id, member);
        assert_eq!(pending.state, "disk");
        // Uppercase hex is not a form Silo produces and stays rejected.
        assert!(import_pending_restore(&paths, ID, group, "c0123456789ABCDEF0123456789abcde").is_err());
        // A bare word that is neither a backup member nor a checkpoint id is rejected.
        assert!(import_pending_restore(&paths, ID, group, "imported-member").is_err());
    }

    #[test]
    fn export_source_resolves_checkpoint_member_and_rejects_unknown_or_inflight() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine()],
            },
        )
        .unwrap();
        let mut record = Record::default();
        record.snapshot_group = Some("dev".into());
        record.checkpoints.push(Checkpoint {
            id: "c000000000000000000000000000001".into(),
            native_id: Some("c0000000000000000000000000000aa".into()),
            name: "Milestone".into(),
            created_at: 1,
            scope: "full".into(),
            reason: "manual".into(),
        });
        save(&paths, ID, &record).unwrap();
        let (group, member, scope, name) =
            export_source(&paths, ID, "c000000000000000000000000000001").unwrap();
        assert_eq!(group, "dev");
        assert_eq!(member, "c0000000000000000000000000000aa");
        assert_eq!(scope, "full");
        assert_eq!(name, "Milestone");
        // Unknown ids are rejected.
        assert!(export_source(&paths, ID, "c000000000000000000000000000999").is_err());
        // An inflight checkpoint cannot be exported until capture finishes.
        let mut inflight = record;
        inflight.inflight_checkpoint = Some(Checkpoint {
            id: "c000000000000000000000000000002".into(),
            native_id: None,
            name: "Capturing".into(),
            created_at: 2,
            scope: "disk".into(),
            reason: "manual".into(),
        });
        save(&paths, ID, &inflight).unwrap();
        assert!(export_source(&paths, ID, "c000000000000000000000000000002").is_err());
    }

    #[test]
    fn imported_disk_snapshot_uses_native_cold_boot_without_full_checkpoint_flag() {
        struct DiskRunner(Mutex<Vec<Vec<String>>>);
        impl RuntimeRunner for DiskRunner {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.0.lock().unwrap().push(args.to_vec());
                let stdout = match args.first().map(String::as_str) {
                    Some("snapshot") => serde_json::json!([{
                        "group":"silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9",
                        "name":"silo-backup-0-330418-1790360984903",
                        "scope":"disk", "availability":"ready"
                    }])
                    .to_string(),
                    Some("list") => "[]".into(),
                    Some("restore") => return Err(error("synthetic restore failure")),
                    _ => panic!("unexpected command: {args:?}"),
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        import_pending_restore(
            &paths,
            ID,
            "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9",
            "silo-backup-0-330418-1790360984903",
        )
        .unwrap();
        let runner = DiskRunner(Mutex::new(Vec::new()));
        assert!(start_pending(&runner, &paths, &machine())
            .unwrap_err()
            .to_string()
            .contains("synthetic restore failure"));
        let calls = runner.0.lock().unwrap();
        let restore = calls
            .iter()
            .find(|args| args.first().is_some_and(|arg| arg == "restore"))
            .unwrap();
        assert_eq!(
            restore[1],
            "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9:silo-backup-0-330418-1790360984903"
        );
        assert!(!restore
            .iter()
            .any(|arg| arg == "--disk-only" || arg == "--forked"));
        assert!(restore.windows(2).any(|args| args == ["--cpus", "1"]));
        assert!(restore.windows(2).any(|args| args == ["--memory", "1G"]));
        assert_eq!(
            load(&paths, ID).unwrap().snapshot_group.as_deref(),
            Some("silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9")
        );
    }

    #[test]
    fn snapshot_group_is_persisted_and_import_provenance_is_not_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        assert_eq!(ensure_snapshot_group(&paths, ID, "dev").unwrap(), "dev");
        assert_eq!(ensure_snapshot_group(&paths, ID, "renamed").unwrap(), "dev");

        let imported_id = "00000000-0000-4000-8000-000000000002";
        let imported_group = "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9";
        import_pending_restore(
            &paths,
            imported_id,
            imported_group,
            "silo-backup-0-330418-1790360984903",
        )
        .unwrap();
        assert_eq!(
            ensure_snapshot_group(&paths, imported_id, "archive-copy").unwrap(),
            imported_group
        );
    }

    #[test]
    fn original_v1_checkpoints_migrate_to_default_group_but_lost_import_group_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut original = Record::default();
        original.checkpoints.push(Checkpoint {
            id: "c000000000000000000000000000000".into(),
            native_id: None,
            name: "Before update".into(),
            created_at: 1,
            scope: "disk".into(),
            reason: "manual".into(),
        });
        save(&paths, ID, &original).unwrap();
        assert_eq!(ensure_snapshot_group(&paths, ID, "dev").unwrap(), "dev");
        assert_eq!(
            load(&paths, ID).unwrap().snapshot_group.as_deref(),
            Some("dev")
        );

        let imported_id = "00000000-0000-4000-8000-000000000003";
        let lost_origin = Record::default();
        save(&paths, imported_id, &lost_origin).unwrap();
        assert!(ensure_snapshot_group(&paths, imported_id, "renamed-import").is_err());
        assert_eq!(load(&paths, imported_id).unwrap().snapshot_group, None);
    }

    struct Runner {
        mount_type: &'static str,
        calls: Mutex<Vec<Vec<String>>>,
    }
    impl RuntimeRunner for Runner {
        fn run(
            &self,
            _paths: &RuntimePaths,
            args: &[String],
            _timeout: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            self.calls.lock().unwrap().push(args.to_vec());
            let stdout = if args[0] == "inspect" {
                serde_json::json!({
                    "name":"dev", "status":"Running", "config":{
                        "labels":{"silo.managed":"true","silo.machine-id":ID},
                        "mounts":[{"guest":"/workspace","type":self.mount_type,
                            "storage":{"kind":"disk","capacity_mib":1024}}]
                    }
                })
                .to_string()
            } else if args[0] == "snapshot" && args[1] == "list" {
                let calls = self.calls.lock().unwrap();
                let name = calls
                    .iter()
                    .find(|call| call.get(1).map(String::as_str) == Some("create"))
                    .and_then(|call| call.get(2))
                    .cloned()
                    .unwrap_or_default();
                serde_json::json!([{"group":"dev","name":name,"scope":"full","availability":"ready"}]).to_string()
            } else {
                String::new()
            };
            Ok(CommandOutput {
                stdout,
                stderr: String::new(),
            })
        }
    }
    fn paths(directory: &tempfile::TempDir) -> RuntimePaths {
        RuntimePaths {
            guest_image: directory.path().join("guest"),
            executable: directory.path().join("msb"),
            home: directory.path().join("home"),
            storage_home: None,
            library: directory.path().join("lib"),
            metadata: directory.path().join("machines.json"),
            volumes: directory.path().join("volumes"),
        }
    }
    fn machine() -> MachineConfiguration {
        MachineConfiguration::Vm {
            id: ID.into(),
            name: "dev".into(),
            cpus: 1,
            max_cpus: 1,
            memory_gib: 1,
            max_memory_gib: 1,
            workspace_storage_gib: 1,
            runtime_storage_gib: 1,
            desktop: None,
        }
    }
    #[test]
    fn fork_from_recovery_uses_saved_policy_only_while_source_is_pending_and_absent() {
        struct SourceRunner {
            present: bool,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for SourceRunner {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout = match args[0].as_str() {
                    "list" => serde_json::json!([{"name":"dev","status":"Stopped"}]).to_string(),
                    "inspect" => {
                        return Err(RuntimeError::Unavailable("sandbox not found: dev".into()))
                    }
                    _ => panic!("unexpected runtime command: {args:?}"),
                };
                Ok(CommandOutput {
                    stdout: if self.present { stdout } else { "[]".into() },
                    stderr: String::new(),
                })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut record = Record::default();
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "silo-import-6b79cf8f70b34f2d93d13eeb3798a8b9".into(),
            state: "full".into(),
        });
        let policy =
            serde_json::json!({"default_egress":"deny","default_ingress":"allow","rules":[]});
        record.desired_network_policy = Some(policy.clone());
        let absent = SourceRunner {
            present: false,
            calls: Mutex::new(Vec::new()),
        };
        assert_eq!(
            fork_source_policy(&absent, &paths, &machine(), &record).unwrap(),
            policy
        );
        assert_eq!(
            absent
                .calls
                .lock()
                .unwrap()
                .iter()
                .map(|args| args[0].as_str())
                .collect::<Vec<_>>(),
            ["list"]
        );
        let present = SourceRunner {
            present: true,
            calls: Mutex::new(Vec::new()),
        };
        assert!(fork_source_policy(&present, &paths, &machine(), &record).is_err());
        assert_eq!(
            present
                .calls
                .lock()
                .unwrap()
                .iter()
                .map(|args| args[0].as_str())
                .collect::<Vec<_>>(),
            ["list", "inspect"]
        );
        record.desired_network_policy = None;
        assert!(fork_source_policy(&absent, &paths, &machine(), &record).is_err());
        record.desired_network_policy = Some(serde_json::json!({"default_egress":"invalid"}));
        assert!(fork_source_policy(&absent, &paths, &machine(), &record).is_err());
    }
    #[test]
    fn captures_full_state_only_with_an_owned_workspace_disk() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine()],
            },
        )
        .unwrap();
        let legacy = Runner {
            mount_type: "DiskImage",
            calls: Mutex::new(Vec::new()),
        };
        assert!(capture_with(&legacy, &paths, ID, "Before work", "manual")
            .unwrap_err()
            .to_string()
            .contains("migration"));
        assert_eq!(legacy.calls.lock().unwrap().len(), 1);
        let owned = Runner {
            mount_type: "Owned",
            calls: Mutex::new(Vec::new()),
        };
        capture_with(&owned, &paths, ID, "Before work", "manual").unwrap();
        let calls = owned.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[1][..2], ["snapshot", "create"]);
        assert!(calls[1].iter().any(|arg| arg == "--full"));
        assert!(calls[1].windows(2).any(|pair| pair == ["--group", "dev"]));
        assert_eq!(load(&paths, ID).unwrap().checkpoints[0].scope, "full");
    }

    #[test]
    fn pending_restore_checkpoint_creation_aliases_immutable_full_snapshot() {
        struct SnapshotInventory {
            present: bool,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for SnapshotInventory {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout = match args[0].as_str() {
                    "list" if self.present => serde_json::json!([{"name":"dev"}]).to_string(),
                    "list" => "[]".into(),
                    "snapshot" if args.get(1).is_some_and(|value| value == "list") => serde_json::json!([
                        {"group":"dev","name":"c000000000000000000000000000000","scope":"full","availability":"ready"}
                    ]).to_string(),
                    _ => panic!("unexpected runtime command: {args:?}"),
                };
                Ok(CommandOutput { stdout, stderr: String::new() })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine()],
            },
        ).unwrap();
        let mut pending = Record::default();
        pending.snapshot_group = Some("dev".into());
        pending.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        pending.desired_network_policy = Some(serde_json::json!({
            "default_egress":"deny", "default_ingress":"deny", "rules":[]
        }));
        save(&paths, ID, &pending).unwrap();
        let runner = SnapshotInventory { present: false, calls: Mutex::new(Vec::new()) };
        capture_with(&runner, &paths, ID, "After restore", "manual").unwrap();
        let stored = load(&paths, ID).unwrap();
        let alias = &stored.checkpoints[0];
        assert_ne!(alias.id, "c000000000000000000000000000000");
        assert_eq!(alias.native_id.as_deref(), Some("c000000000000000000000000000000"));
        assert_eq!(alias.scope, "full");
        assert_eq!(stored.pending_checkpoint_restore.unwrap().checkpoint_id, "c000000000000000000000000000000");
        assert!(runner.calls.lock().unwrap().iter().all(|args| args[0] != "inspect" && args.get(1).map(String::as_str) != Some("create")));

        let mut legacy = Record::default();
        legacy.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        legacy.desired_network_policy = stored.desired_network_policy;
        save(&paths, ID, &legacy).unwrap();
        capture_with(&runner, &paths, ID, "Legacy alias", "manual").unwrap();
        assert_eq!(load(&paths, ID).unwrap().snapshot_group.as_deref(), Some("dev"));

        let before_collision = load(&paths, ID).unwrap();
        let collision = SnapshotInventory { present: true, calls: Mutex::new(Vec::new()) };
        assert!(capture_with(&collision, &paths, ID, "Unsafe alias", "manual").is_err());
        assert_eq!(load(&paths, ID).unwrap().checkpoints.len(), before_collision.checkpoints.len());
        assert!(!collision.calls.lock().unwrap().iter().any(|args| args[0] == "inspect"));
    }

    #[test]
    fn pending_full_checkpoint_can_be_aliased_switched_recovered_and_started_explicitly() {
        struct Inventory {
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for Inventory {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout = match args[0].as_str() {
                    "list" => "[]".into(),
                    "snapshot" if args.get(1).is_some_and(|value| value == "list") => serde_json::json!([
                        {"group":"dev","name":"c000000000000000000000000000000","scope":"full","availability":"ready"},
                        {"group":"dev","name":"c111111111111111111111111111111","scope":"full","availability":"ready"}
                    ]).to_string(),
                    "snapshot" if args.get(1).is_some_and(|value| value == "verify") => "{}".into(),
                    "restore" => return Err(error("synthetic restore failure after request capture")),
                    _ => panic!("unexpected runtime command: {args:?}"),
                };
                Ok(CommandOutput { stdout, stderr: String::new() })
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest { schema_version: 1, machines: vec![machine()] },
        ).unwrap();
        let first = Checkpoint {
            id: "c000000000000000000000000000000".into(),
            native_id: None,
            name: "First full state".into(),
            created_at: 1,
            scope: "full".into(),
            reason: "manual".into(),
        };
        let second = Checkpoint {
            id: "c111111111111111111111111111111".into(),
            native_id: None,
            name: "Second full state".into(),
            created_at: 2,
            scope: "full".into(),
            reason: "manual".into(),
        };
        let mut record = Record::default();
        record.snapshot_group = Some("dev".into());
        record.checkpoints = vec![first.clone(), second.clone()];
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: first.id.clone(),
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        record.desired_network_policy = Some(serde_json::json!({
            "default_egress":"deny", "default_ingress":"allow", "rules":[]
        }));
        save(&paths, ID, &record).unwrap();
        let runner = Inventory { calls: Mutex::new(Vec::new()) };

        capture_with(&runner, &paths, ID, "Saved first state", "manual").unwrap();
        let alias = load(&paths, ID).unwrap().checkpoints[0].clone();
        assert_eq!(alias.native_id(), first.id);
        assert_eq!(alias.scope, "full");

        restore_with(&runner, &paths, ID, &second.id).unwrap();
        let after_switch = load(&paths, ID).unwrap();
        let recovery_of_first = after_switch.checkpoints[0].clone();
        assert_ne!(recovery_of_first.id, first.id);
        assert_eq!(recovery_of_first.name, "Before restore");
        assert_eq!(recovery_of_first.reason, "before-restore");
        assert_eq!(recovery_of_first.native_id(), first.id);
        assert_eq!(recovery_of_first.scope, "full");
        assert_eq!(after_switch.pending_checkpoint_restore.unwrap().checkpoint_id, second.id);

        restore_with(&runner, &paths, ID, &recovery_of_first.id).unwrap();
        let restored = load(&paths, ID).unwrap();
        assert_eq!(restored.pending_checkpoint_restore.as_ref().unwrap().checkpoint_id, first.id);
        assert!(restored.checkpoints.iter().any(|checkpoint| {
            checkpoint.native_id() == second.id && checkpoint.reason == "before-restore"
        }));

        let host = super::super::HostResources {
            logical_cpus: 8,
            physical_memory_bytes: Some(16 * 1024 * 1024 * 1024),
        };
        let failure = super::super::explicit_workspace_action_with(
            &runner, &paths, &host, "start", "dev",
        ).unwrap_err();
        assert!(failure.to_string().contains("synthetic restore failure"));
        let calls = runner.calls.lock().unwrap();
        let start = calls.iter().find(|args| args[0] == "restore").unwrap();
        assert_eq!(start[1], format!("dev:{}", first.id));
        assert!(start.iter().any(|arg| arg == "--forked"));
        assert!(!start.iter().any(|arg| arg == "--disk-only"));
        assert!(load(&paths, ID).unwrap().pending_checkpoint_restore.is_some());
    }

    #[test]
    fn current_state_fork_from_pending_full_snapshot_reuses_reference_without_starting() {
        struct ForkInventory {
            present: bool,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for ForkInventory {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout = match args[0].as_str() {
                    "list" if self.present => serde_json::json!([{"name":"dev"}]).to_string(),
                    "list" => "[]".into(),
                    "snapshot" if args.get(1).is_some_and(|value| value == "list") => serde_json::json!([
                        {"group":"dev","name":"silo-backup-0-330418-1790360984903","scope":"full","availability":"ready"}
                    ]).to_string(),
                    _ => panic!("unexpected runtime command: {args:?}"),
                };
                Ok(CommandOutput { stdout, stderr: String::new() })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut record = Record::default();
        record.snapshot_group = Some("dev".into());
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "silo-backup-0-330418-1790360984903".into(),
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        record.desired_network_policy = Some(serde_json::json!({
            "default_egress":"deny", "default_ingress":"allow", "rules":[]
        }));
        let runner = ForkInventory { present: false, calls: Mutex::new(Vec::new()) };
        let point = pending_current_fork_point(&runner, &paths, "dev", &record, "dev")
            .unwrap()
            .unwrap();
        assert_eq!(point.checkpoint_id, "silo-backup-0-330418-1790360984903");
        assert_eq!(point.state, "full");
        assert_eq!(runner.calls.lock().unwrap().iter().map(|args| args[0].as_str()).collect::<Vec<_>>(), ["list", "snapshot"]);

        let collision = ForkInventory { present: true, calls: Mutex::new(Vec::new()) };
        assert!(pending_current_fork_point(&collision, &paths, "dev", &record, "dev").is_err());
        assert_eq!(collision.calls.lock().unwrap().len(), 1);
    }

    struct Observed {
        status: &'static str,
        missing: bool,
        calls: Mutex<usize>,
    }
    impl RuntimeRunner for Observed {
        fn run(&self, _: &RuntimePaths, args: &[String], _: Duration) -> Result<CommandOutput, RuntimeError> {
            *self.calls.lock().unwrap() += 1;
            assert_eq!(args[0], "inspect");
            if self.missing {
                return Err(RuntimeError::Failed { operation: "Inspecting the sandbox".into(), detail: "exit code 1: sandbox 'dev' not found".into() });
            }
            Ok(CommandOutput {
                stdout: serde_json::json!({"name":"dev","status":self.status,"config":{"labels":{"silo.managed":"true","silo.machine-id":ID}}}).to_string(),
                stderr: String::new(),
            })
        }
    }
    #[test]
    fn pending_and_stopped_vms_read_as_stopped_and_ask_to_be_started() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(&paths.metadata, &MachineConfigurationRequest { schema_version: 1, machines: vec![machine()] }).unwrap();

        // Normally stopped: inspected, present, and actions say to start it.
        let stopped = Observed { status: "Stopped", missing: false, calls: Mutex::new(0) };
        assert!(matches!(observe_vm(&stopped, &paths, "dev").unwrap(), VmRuntime::Present(_)));
        assert_eq!(crate::terminal::running_vm_with(&stopped, &paths, "dev").err().unwrap(), "Start dev first.");

        // A runtime that does not know the sandbox is stopped, not an error.
        let missing = Observed { status: "", missing: true, calls: Mutex::new(0) };
        assert!(matches!(observe_vm(&missing, &paths, "dev").unwrap(), VmRuntime::Absent));

        // Pending restore: decided from Silo's record; the runtime is never asked.
        let mut record = Record::default();
        record.pending_checkpoint_restore = Some(PendingRestore { checkpoint_id: "c000000000000000000000000000000".into(), source_workspace: "source".into(), state: "full".into() });
        save(&paths, ID, &record).unwrap();
        let pending = Observed { status: "Running", missing: false, calls: Mutex::new(0) };
        assert!(matches!(observe_vm(&pending, &paths, "dev").unwrap(), VmRuntime::Absent));
        assert!(is_pending_restore(&paths, "dev"));
        assert_eq!(crate::terminal::running_vm_with(&pending, &paths, "dev").err().unwrap(), "Start dev first.");
        assert_eq!(*pending.calls.lock().unwrap(), 0);
        // Network reads its saved ports as stopped: no error, no raw inspect failure.
        let (error, ports) = crate::network::observe_saved_port_for_test(&paths, "dev", 3000);
        assert_eq!(error, None);
        assert_eq!(ports, vec![("waiting", None)]);

        // Other runtime failures still surface.
        struct Broken;
        impl RuntimeRunner for Broken {
            fn run(&self, _: &RuntimePaths, _: &[String], _: Duration) -> Result<CommandOutput, RuntimeError> {
                Err(RuntimeError::Unavailable("runtime down".into()))
            }
        }
        delete_record_for_test(&paths);
        assert!(observe_vm(&Broken, &paths, "dev").is_err());
    }
    fn delete_record_for_test(paths: &RuntimePaths) {
        save(paths, ID, &Record::default()).unwrap();
    }
    #[test]
    fn pending_fork_survives_reload_and_cannot_auto_start_or_use_lifecycle_start() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine()],
            },
        )
        .unwrap();
        let mut record = Record::default();
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "source".into(),
            state: "full".into(),
        });
        save(&paths, ID, &record).unwrap();
        assert!(is_pending(&paths, ID).unwrap());
        let runner = Runner {
            mount_type: "Owned",
            calls: Mutex::new(Vec::new()),
        };
        let host = HostResources {
            logical_cpus: 8,
            physical_memory_bytes: Some(16 * 1024 * 1024 * 1024),
        };
        start_at_launch_with(&runner, &paths, &host, ID).unwrap();
        assert!(runner.calls.lock().unwrap().is_empty());
        assert!(workspace_action_with(&runner, &paths, &host, "start", "dev").is_err());
        assert!(runner.calls.lock().unwrap().is_empty());
        assert!(run_msb(
            &paths,
            &["exec".into(), "dev".into(), "--".into(), "true".into()],
            READ_TIMEOUT
        )
        .unwrap_err()
        .to_string()
        .contains("explicit Start"));
        let view = pending_workspace(machine()).unwrap();
        assert!(matches!(view.state, WorkspaceState::Stopped));
    }
    #[test]
    fn first_start_network_flags_preserve_current_asymmetric_policy() {
        let config = serde_json::json!({"network":{"policy":{
            "default_egress":"deny", "default_ingress":"allow", "rules":[
                {"action":"allow","direction":"egress","destination":{"group":"host"},
                    "protocols":["udp","tcp"],"ports":[{"start":53,"end":53}]},
                {"action":"allow","direction":"egress","destination":{"group":"public"},
                    "protocols":[],"ports":[]}
            ]
        }}});
        let args = current_network_args(&config).unwrap();
        assert_eq!(
            args,
            [
                "--net-default-egress",
                "deny",
                "--net-default-ingress",
                "allow",
                "--net-rule",
                "allow@dns",
                "--net-rule",
                "allow@public",
            ]
        );
    }
    #[test]
    fn failed_first_start_preserves_pending_checkpoint_and_source() {
        struct FailedRestore {
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for FailedRestore {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout = match args[0].as_str() {
                    "inspect" => serde_json::json!({"name":"dev","status":"Running","config":{
                        "labels":{"silo.managed":"true","silo.machine-id":ID},
                        "network":{"policy":{"default_egress":"deny","default_ingress":"allow","rules":[]}}
                    }}).to_string(),
                    "snapshot" => serde_json::json!([{"group":"dev","name":"c000000000000000000000000000000","scope":"full","availability":"ready"}]).to_string(),
                    "list" => serde_json::json!([{"name":"dev"}]).to_string(),
                    "restore" => return Err(RuntimeError::Failed {operation:"restore".into(),detail:"synthetic failure".into()}),
                    _ => panic!("unexpected runtime command"),
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut child = machine();
        let child_id = "00000000-0000-4000-8000-000000000002";
        if let MachineConfiguration::Vm { id, name, .. } = &mut child {
            *id = child_id.into();
            *name = "fork".into();
        }
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine(), child.clone()],
            },
        )
        .unwrap();
        let mut record = Record::default();
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        record.desired_network_policy =
            Some(serde_json::json!({"default_egress":"deny","default_ingress":"allow","rules":[]}));
        save(&paths, child_id, &record).unwrap();
        let runner = FailedRestore {
            calls: Mutex::new(Vec::new()),
        };
        assert!(start_pending(&runner, &paths, &child)
            .unwrap_err()
            .to_string()
            .contains("synthetic failure"));
        let stored = load(&paths, child_id).unwrap();
        assert!(stored.pending_checkpoint_restore.is_some());
        assert_eq!(stored.checkpoint_operation.unwrap().status, "failed");
        assert!(read_metadata(&paths.metadata)
            .unwrap()
            .machines
            .iter()
            .any(|m| m.name() == "dev"));
        assert_eq!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|args| args[0] == "restore")
                .count(),
            1
        );
    }
    #[test]
    fn restore_journal_distinguishes_original_before_and_after_runtime_removal() {
        struct Listing {
            present: bool,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for Listing {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout = if args[0] == "list" {
                    if self.present {
                        serde_json::json!([{"name":"dev"}]).to_string()
                    } else {
                        "[]".into()
                    }
                } else if args[0] == "snapshot" && args[1] == "list" {
                    serde_json::json!([{"group":"dev","name":"c000000000000000000000000000000","scope":"full","availability":"ready"}]).to_string()
                } else if args[0] == "restore" {
                    return Err(error("synthetic restore failure"));
                } else {
                    panic!("unexpected runtime command")
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine()],
            },
        )
        .unwrap();
        let target = Checkpoint {
            id: "c000000000000000000000000000000".into(),
            native_id: None,
            name: "target".into(),
            created_at: 1,
            scope: "full".into(),
            reason: "manual".into(),
        };
        let recovery = Checkpoint {
            id: "c111111111111111111111111111111".into(),
            native_id: None,
            name: "Before restore".into(),
            created_at: 2,
            scope: "full".into(),
            reason: "before-restore".into(),
        };
        let mut record = Record::default();
        record.checkpoints = vec![recovery.clone(), target.clone()];
        record.restore_journal = Some(RestoreJournal {
            target_checkpoint_id: target.id.clone(),
            recovery_checkpoint: recovery,
            prior_running: true,
            phase: "secured".into(),
        });
        record.desired_network_policy =
            Some(serde_json::json!({"default_egress":"deny","default_ingress":"allow","rules":[]}));
        save(&paths, ID, &record).unwrap();
        assert!(!pending_view(&paths, ID, true).unwrap());
        assert!(pending_view(&paths, ID, false).unwrap());
        let original = Listing {
            present: true,
            calls: Mutex::new(Vec::new()),
        };
        assert!(start_pending(&original, &paths, &machine())
            .unwrap_err()
            .to_string()
            .contains("original VM"));
        assert_eq!(original.calls.lock().unwrap().len(), 1);
        assert!(load(&paths, ID)
            .unwrap()
            .pending_checkpoint_restore
            .is_none());
        let removed = Listing {
            present: false,
            calls: Mutex::new(Vec::new()),
        };
        let failure = start_pending(&removed, &paths, &machine()).unwrap_err();
        assert!(
            failure.to_string().contains("synthetic restore failure"),
            "{failure}"
        );
        let after = load(&paths, ID).unwrap();
        assert!(after.pending_checkpoint_restore.is_some());
        assert!(after.restore_journal.is_none());
        assert!(!removed
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| args[0] == "remove"));

        let mut fork = load(&paths, ID).unwrap();
        fork.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: target.id,
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        save(&paths, ID, &fork).unwrap();
        let fork_failure = start_pending(&removed, &paths, &machine()).unwrap_err();
        assert!(
            fork_failure
                .to_string()
                .contains("synthetic restore failure"),
            "{fork_failure}"
        );
        let calls = removed.calls.lock().unwrap();
        assert!(calls
            .iter()
            .any(|args| args.first().map(String::as_str) == Some("restore")
                && args.get(1).map(String::as_str) == Some("dev:c000000000000000000000000000000")));
    }
    #[test]
    fn failed_child_cleanup_requires_the_saved_attempt_label() {
        struct WrongChild {
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for WrongChild {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout = match args[0].as_str() {
                    "snapshot" => serde_json::json!([{"group":"source","name":"c000000000000000000000000000000","scope":"full","availability":"ready"}]).to_string(),
                    "list" => serde_json::json!([{"name":"fork"}]).to_string(),
                    "inspect" => serde_json::json!({"name":"fork","status":"Stopped","config":{
                        "labels":{"silo.managed":"true","silo.machine-id":"00000000-0000-4000-8000-000000000002"},
                        "network":{"policy":{"default_egress":"deny","default_ingress":"allow","rules":[]}}
                    }}).to_string(),
                    _ => panic!("cleanup must not touch an unverified child"),
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        let mut child = machine();
        let child_id = "00000000-0000-4000-8000-000000000002";
        if let MachineConfiguration::Vm { id, name, .. } = &mut child {
            *id = child_id.into();
            *name = "fork".into();
        }
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![child.clone()],
            },
        )
        .unwrap();
        let mut record = Record::default();
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "source".into(),
            state: "full".into(),
        });
        record.desired_network_policy =
            Some(serde_json::json!({"default_egress":"deny","default_ingress":"allow","rules":[]}));
        record.restore_attempted = true;
        record.restore_attempt_id = Some(uuid::Uuid::new_v4().to_string());
        save(&paths, child_id, &record).unwrap();
        let runner = WrongChild {
            calls: Mutex::new(Vec::new()),
        };
        assert!(start_pending(&runner, &paths, &child)
            .unwrap_err()
            .to_string()
            .contains("unverified"));
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| args[0] == "remove"));
    }
    #[test]
    fn restore_secures_recovery_before_retiring_original_and_keeps_stable_identity() {
        struct RestoreRunner {
            state: Mutex<&'static str>,
            recovery: Mutex<Option<String>>,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl RuntimeRunner for RestoreRunner {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.calls.lock().unwrap().push(args.to_vec());
                let stdout=match args[0].as_str() {
                    "inspect" => serde_json::json!({"name":"dev","status":*self.state.lock().unwrap(),"config":{
                        "labels":{"silo.managed":"true","silo.machine-id":ID},
                        "mounts":[{"guest":"/workspace","type":"Owned","storage":{"kind":"disk","capacity_mib":1024}}],
                        "network":{"policy":{"default_egress":"deny","default_ingress":"allow","rules":[]}}
                    }}).to_string(),
                    "snapshot" if args[1]=="list" => {
                        let mut entries=vec![serde_json::json!({"group":"dev","name":"c000000000000000000000000000000","scope":"full","availability":"ready"})];
                        if let Some(id)=self.recovery.lock().unwrap().as_ref() {
                            entries.push(serde_json::json!({"group":"dev","name":id,"scope":"full","availability":"ready"}));
                        }
                        serde_json::to_string(&entries).unwrap()
                    }
                    "snapshot" if args[1]=="create" => { *self.recovery.lock().unwrap()=Some(args[2].clone()); String::new() }
                    "snapshot" if args[1]=="verify" => String::new(),
                    "pause" => { *self.state.lock().unwrap()="Paused"; String::new() },
                    "stop" => { assert!(args.iter().any(|arg| arg=="--force")); *self.state.lock().unwrap()="Stopped"; String::new() },
                    "remove" => { *self.state.lock().unwrap()="Removed"; String::new() },
                    "list" => "[]".into(),
                    _ => panic!("unexpected runtime command: {args:?}"),
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine()],
            },
        )
        .unwrap();
        let mut record = Record::default();
        record.checkpoints.push(Checkpoint {
            id: "c000000000000000000000000000000".into(),
            native_id: None,
            name: "Selected".into(),
            created_at: 1,
            scope: "full".into(),
            reason: "manual".into(),
        });
        save(&paths, ID, &record).unwrap();
        let runner = RestoreRunner {
            state: Mutex::new("Running"),
            recovery: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
        };
        restore_with(&runner, &paths, ID, "c000000000000000000000000000000").unwrap();
        let calls = runner.calls.lock().unwrap();
        let position = |command: &str| calls.iter().position(|args| args[0] == command).unwrap();
        assert!(position("pause") < position("stop"));
        assert!(position("snapshot") < position("remove"));
        let verify_recovery = calls
            .iter()
            .rposition(|args| args.get(1).map(String::as_str) == Some("verify"))
            .unwrap();
        assert!(verify_recovery < position("remove"));
        let stored = load(&paths, ID).unwrap();
        assert_eq!(stored.checkpoints[0].reason, "before-restore");
        assert_eq!(
            stored.pending_checkpoint_restore.unwrap().checkpoint_id,
            "c000000000000000000000000000000"
        );
        assert!(stored.restore_journal.is_none());
        assert_eq!(read_metadata(&paths.metadata).unwrap().machines[0].id(), ID);
        assert_eq!(
            read_metadata(&paths.metadata).unwrap().machines[0].name(),
            "dev"
        );
        drop(calls);
        let source = read_application_state_with(&runner, &paths).unwrap();
        assert!(matches!(source.workspaces[0].state, WorkspaceState::Stopped));
        assert!(source.workspaces[0].pending_checkpoint_restore.is_some());
        let calls = runner.calls.lock().unwrap();
        let remove = calls.iter().position(|args| args[0] == "remove").unwrap();
        assert!(calls[remove + 1..].iter().all(|args| args[0] == "list"));
    }

    struct JournalRunner {
        state: Mutex<&'static str>,
        fail: &'static str,
        listed: bool,
        recovery: Mutex<Option<String>>,
        calls: Mutex<Vec<Vec<String>>>,
    }
    impl RuntimeRunner for JournalRunner {
        fn run(
            &self,
            _paths: &RuntimePaths,
            args: &[String],
            _timeout: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            self.calls.lock().unwrap().push(args.to_vec());
            let command = if args[0] == "snapshot" { args[1].as_str() } else { args[0].as_str() };
            if command == self.fail {
                return Err(RuntimeError::Unavailable(format!("{} failed on this host.", self.fail)));
            }
            let stdout = match command {
                "inspect" => serde_json::json!({"name":"dev","status":*self.state.lock().unwrap(),"config":{
                    "labels":{"silo.managed":"true","silo.machine-id":ID},
                    "mounts":[{"guest":"/workspace","type":"Owned","storage":{"kind":"disk","capacity_mib":1024}}],
                    "network":{"policy":{"default_egress":"deny","default_ingress":"allow","rules":[]}}
                }}).to_string(),
                "list" if args[0] == "snapshot" => {
                    let full = self.calls.lock().unwrap().iter().any(|call| call.iter().any(|arg| arg == "--full"));
                    let mut entries = vec![serde_json::json!({"group":"dev","name":"c000000000000000000000000000000","scope":"full","availability":"ready"})];
                    if let Some(id) = self.recovery.lock().unwrap().as_ref() {
                        let scope = if full { "full" } else { "disk" };
                        entries.push(serde_json::json!({"group":"dev","name":id,"scope":scope,"availability":"ready"}));
                    }
                    serde_json::to_string(&entries).unwrap()
                }
                "create" => {
                    *self.recovery.lock().unwrap() = Some(args[2].clone());
                    String::new()
                }
                "pause" => {
                    *self.state.lock().unwrap() = "Paused";
                    String::new()
                }
                "resume" => {
                    *self.state.lock().unwrap() = "Running";
                    String::new()
                }
                "stop" => {
                    *self.state.lock().unwrap() = "Stopped";
                    String::new()
                }
                "remove" => {
                    *self.state.lock().unwrap() = "Removed";
                    String::new()
                }
                "list" if self.listed => r#"[{"name":"dev"}]"#.into(),
                "list" => "[]".into(),
                _ => String::new(),
            };
            Ok(CommandOutput {
                stdout,
                stderr: String::new(),
            })
        }
    }

    fn journal_runner(state: &'static str, fail: &'static str) -> JournalRunner {
        JournalRunner {
            state: Mutex::new(state),
            fail,
            listed: false,
            recovery: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn restore_fixture(directory: &tempfile::TempDir, journal: Option<(&str, bool)>) -> RuntimePaths {
        let paths = paths(directory);
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine()],
            },
        )
        .unwrap();
        let mut record = Record::default();
        record.checkpoints.push(Checkpoint {
            id: "c000000000000000000000000000000".into(),
            native_id: None,
            name: "Selected".into(),
            created_at: 1,
            scope: "full".into(),
            reason: "manual".into(),
        });
        if let Some((phase, prior_running)) = journal {
            record.restore_journal = Some(RestoreJournal {
                target_checkpoint_id: "c000000000000000000000000000000".into(),
                recovery_checkpoint: Checkpoint {
                    id: "c111111111111111111111111111111".into(),
                    native_id: None,
                    name: "Before restore".into(),
                    created_at: 2,
                    scope: if prior_running { "full" } else { "disk" }.into(),
                    reason: "before-restore".into(),
                },
                prior_running,
                phase: phase.into(),
            });
            record.checkpoint_operation = Some(Operation {
                kind: "restore".into(),
                status: "running".into(),
                stage: "Creating recovery checkpoint".into(),
                error: None,
            });
        }
        save(&paths, ID, &record).unwrap();
        paths
    }

    #[test]
    fn capturing_journal_for_a_stopped_vm_secures_a_disk_recovery_and_finishes() {
        for status in ["Stopped", "Created", "Crashed"] {
            let directory = tempfile::tempdir().unwrap();
            let paths = restore_fixture(&directory, Some(("capturing", true)));
            let runner = journal_runner(status, "");
            restore_with(&runner, &paths, ID, "c000000000000000000000000000000").unwrap();
            let calls = runner.calls.lock().unwrap();
            let create = calls
                .iter()
                .find(|call| call[0] == "snapshot" && call[1] == "create")
                .unwrap();
            assert!(!create.iter().any(|arg| arg == "--full"), "{status}: {create:?}");
            assert!(!calls.iter().any(|call| call[0] == "pause"));
            let stored = load(&paths, ID).unwrap();
            assert!(stored.restore_journal.is_none());
            assert!(stored.pending_checkpoint_restore.is_some());
            let recovery = stored
                .checkpoints
                .iter()
                .find(|checkpoint| checkpoint.reason == "before-restore")
                .unwrap();
            assert_eq!(recovery.scope, "disk");
        }
    }

    #[test]
    fn failed_pause_clears_the_capturing_journal_and_records_the_real_error() {
        let directory = tempfile::tempdir().unwrap();
        let paths = restore_fixture(&directory, None);
        let runner = journal_runner("Running", "pause");
        let failure = restore_with(&runner, &paths, ID, "c000000000000000000000000000000")
            .unwrap_err()
            .to_string();
        assert_eq!(failure, "pause failed on this host.");
        let stored = load(&paths, ID).unwrap();
        assert!(stored.restore_journal.is_none());
        let operation = stored.checkpoint_operation.unwrap();
        assert_eq!(operation.status, "failed");
        assert_eq!(operation.error.as_deref(), Some("pause failed on this host."));
        assert!(!needs_explicit_start(&paths, ID).unwrap());
    }

    #[test]
    fn failed_capture_of_a_stopped_vm_leaves_no_journal() {
        let directory = tempfile::tempdir().unwrap();
        let paths = restore_fixture(&directory, Some(("capturing", true)));
        let runner = journal_runner("Stopped", "create");
        restore_with(&runner, &paths, ID, "c000000000000000000000000000000").unwrap_err();
        let stored = load(&paths, ID).unwrap();
        assert!(stored.restore_journal.is_none());
        assert_eq!(stored.checkpoint_operation.unwrap().status, "failed");
    }

    #[test]
    fn secured_restore_errors_persist_a_failed_status_with_the_real_error() {
        let directory = tempfile::tempdir().unwrap();
        let paths = restore_fixture(&directory, Some(("secured", true)));
        let mut runner = journal_runner("Running", "");
        runner.listed = true;
        let failure = restore_with(&runner, &paths, ID, "c000000000000000000000000000000")
            .unwrap_err()
            .to_string();
        assert!(failure.contains("resumed after its recovery checkpoint"), "{failure}");
        let operation = load(&paths, ID).unwrap().checkpoint_operation.unwrap();
        assert_eq!(operation.status, "failed");
        assert_eq!(operation.error.as_deref(), Some(failure.as_str()));
    }

    #[test]
    fn crashed_vm_can_retry_a_secured_restore() {
        let directory = tempfile::tempdir().unwrap();
        let paths = restore_fixture(&directory, Some(("secured", true)));
        let mut runner = journal_runner("Crashed", "");
        runner.listed = true;
        restore_with(&runner, &paths, ID, "c000000000000000000000000000000").unwrap();
        let stored = load(&paths, ID).unwrap();
        assert!(stored.restore_journal.is_none());
        assert!(stored.pending_checkpoint_restore.is_some());
    }

    #[test]
    fn interrupted_checkpoint_is_kept_when_the_snapshot_list_fails() {
        let directory = tempfile::tempdir().unwrap();
        let paths = restore_fixture(&directory, None);
        let mut record = load(&paths, ID).unwrap();
        record.snapshot_group = Some("dev".into());
        record.inflight_checkpoint = Some(Checkpoint {
            id: "c222222222222222222222222222222".into(),
            native_id: None,
            name: "Interrupted".into(),
            created_at: 3,
            scope: "full".into(),
            reason: "manual".into(),
        });
        save(&paths, ID, &record).unwrap();
        let runner = journal_runner("Running", "list");
        capture_with(&runner, &paths, ID, "Next", "manual").unwrap_err();
        let stored = load(&paths, ID).unwrap();
        assert_eq!(
            stored.inflight_checkpoint.map(|checkpoint| checkpoint.id).as_deref(),
            Some("c222222222222222222222222222222")
        );
    }

    #[test]
    fn attempted_restore_with_a_listed_runtime_reads_as_a_present_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let paths = restore_fixture(&directory, None);
        let mut record = load(&paths, ID).unwrap();
        record.pending_checkpoint_restore = Some(PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        save(&paths, ID, &record).unwrap();
        assert!(pending_view(&paths, ID, false).unwrap());
        assert!(pending_view(&paths, ID, true).unwrap());
        record.restore_attempted = true;
        record.restore_attempt_id = Some(uuid::Uuid::new_v4().to_string());
        save(&paths, ID, &record).unwrap();
        assert!(pending_view(&paths, ID, false).unwrap());
        assert!(!pending_view(&paths, ID, true).unwrap());
        let record = load(&paths, ID).unwrap();
        assert!(view_pending(&record, "dev").is_some());
        assert!(needs_explicit_start(&paths, ID).unwrap());
    }

    #[test]
    fn failure_record_save_errors_keep_the_original_error() {
        let directory = tempfile::tempdir().unwrap();
        let paths = paths(&directory);
        fs::write(directory.path().join("checkpoints"), b"not a directory").unwrap();
        let failure = save_failure(
            &paths,
            ID,
            &Record::default(),
            RuntimeError::Unavailable("No space left on device.".into()),
        )
        .to_string();
        assert!(failure.starts_with("No space left on device."), "{failure}");
        assert!(failure.contains("could not be updated"));
    }
}
