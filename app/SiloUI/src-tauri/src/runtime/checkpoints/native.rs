//! MicroSandbox's native snapshot store as Silo sees it: which members exist, what
//! still depends on each one, and removal that never bypasses MicroSandbox's guards.
//!
//! Removal always calls `msb snapshot remove` without `--force` (see the E-03 design
//! note). Beyond MicroSandbox's own children and head guards, Silo keeps a member that:
//! - any Silo record references (a checkpoint, a capture in progress, a Restore's
//!   recovery point, or a fork or import that has not started yet);
//! - is a live sandbox's lineage position: the snapshot its next capture names as parent.
//!   Exports save captures `--with-parents`, which fails when an ancestor is missing.
use super::*;
use std::collections::{HashMap, HashSet};

/// A native member as `msb snapshot list --format json` reports it.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct Member {
    #[serde(default)]
    pub(crate) snapshot_id: String,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) group: Option<String>,
    /// The parent's snapshot id (the index keeps the historical column name).
    #[serde(default)]
    pub(crate) parent_digest: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) artifact_path: Option<String>,
}

impl Member {
    pub(crate) fn key(&self) -> Option<Key> {
        Some((self.group.clone()?, self.name.clone()?))
    }
}

/// `(group, member name)`: the selector Silo records and `msb` accepts as `group:name`.
pub(crate) type Key = (String, String);

pub(crate) fn inventory(runner: &dyn RuntimeRunner, paths: &RuntimePaths) -> Result<Vec<Member>, RuntimeError> {
    let output = runner.run(
        paths,
        &["snapshot".into(), "list".into(), "--format".into(), "json".into()],
        READ_TIMEOUT,
    )?;
    let members: Vec<Member> = serde_json::from_str(&output.stdout)
        .map_err(|_| error("The runtime returned an invalid checkpoint list."))?;
    Ok(members.into_iter().filter(|member| member.key().is_some() && !member.snapshot_id.is_empty()).collect())
}

/// What a Silo record uses a native member for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Purpose {
    /// A checkpoint in the sandbox's history: `(Silo checkpoint id, display name)`.
    Checkpoint(String, String),
    /// A checkpoint capture that has not been recorded yet.
    Capturing,
    /// The recovery point of an unfinished Restore.
    RestoreRecovery,
    /// A fork, import, or Restore that starts from this member on its next Start.
    PendingStart,
}

#[derive(Clone, Debug)]
pub(crate) struct Use {
    pub(crate) workspace_id: String,
    pub(crate) sandbox: String,
    pub(crate) purpose: Purpose,
}

/// Every member one record references. Checkpoints live in the record's lineage group.
pub(crate) fn record_uses(record: &Record, sandbox: &str) -> Vec<(Key, Purpose)> {
    let group = record.snapshot_group.clone().unwrap_or_else(|| sandbox.to_owned());
    let mut uses: Vec<(Key, Purpose)> = record
        .checkpoints
        .iter()
        .map(|checkpoint| {
            (
                (group.clone(), checkpoint.native_id().to_owned()),
                Purpose::Checkpoint(checkpoint.id.clone(), checkpoint.name.clone()),
            )
        })
        .collect();
    if let Some(inflight) = &record.inflight_checkpoint {
        uses.push(((group.clone(), inflight.native_id().to_owned()), Purpose::Capturing));
    }
    if let Some(journal) = &record.restore_journal {
        uses.push((
            (group.clone(), journal.recovery_checkpoint.native_id().to_owned()),
            Purpose::RestoreRecovery,
        ));
    }
    if let Some(pending) = &record.pending_checkpoint_restore {
        uses.push((
            (pending.source_workspace.clone(), pending.checkpoint_id.clone()),
            Purpose::PendingStart,
        ));
    }
    uses
}

/// References from every configured sandbox's record. Fails closed: a record that cannot
/// be read might reference any member.
pub(crate) fn uses(
    paths: &RuntimePaths,
    metadata: &MachineConfigurationRequest,
) -> Result<HashMap<Key, Vec<Use>>, RuntimeError> {
    let mut all: HashMap<Key, Vec<Use>> = HashMap::new();
    for machine in metadata.machines.iter().filter(|machine| machine.is_vm()) {
        let record = load(paths, machine.id())?;
        for (key, purpose) in record_uses(&record, machine.name()) {
            all.entry(key).or_default().push(Use {
                workspace_id: machine.id().into(),
                sandbox: machine.name().into(),
                purpose,
            });
        }
    }
    Ok(all)
}

/// Snapshot ids that live sandboxes build on, mapped to one such sandbox's name: the
/// snapshot a sandbox was restored from and its latest capture. MicroSandbox names that
/// snapshot as the parent of the sandbox's next capture. Fails closed.
pub(crate) fn lineage_positions(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
) -> Result<HashMap<String, String>, RuntimeError> {
    let listed = runner.run(
        paths,
        &["list".into(), "--format".into(), "json".into()],
        READ_TIMEOUT,
    )?;
    let listed: Vec<ListedSandbox> = serde_json::from_str(&listed.stdout)
        .map_err(|_| error("The runtime returned an invalid sandbox list."))?;
    let mut positions = HashMap::new();
    for sandbox in listed {
        let inspected = inspect_workspace(runner, paths, &sandbox.name)?;
        for config in std::iter::once(&inspected.config).chain(inspected.active_config.as_ref()) {
            if let Some(parent) = config.get("snapshot_parent").and_then(Value::as_str) {
                positions.insert(parent.to_owned(), sandbox.name.clone());
            }
        }
        // MicroSandbox's per-sandbox capture cursor. Read, never written; any snapshot id in
        // it is treated as a position so a format change keeps members rather than losing them.
        let cursor = paths.home.join("sandboxes").join(&sandbox.name).join("snapshot-lineage.json");
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= 4096 => {
                let bytes = fs::read(&cursor).map_err(|_| error("A sandbox's checkpoint lineage could not be read."))?;
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| error("A sandbox's checkpoint lineage is not in a known format."))?;
                let mut ids = Vec::new();
                snapshot_ids(&value, &mut ids);
                for id in ids {
                    positions.insert(id, sandbox.name.clone());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(error("A sandbox's checkpoint lineage could not be read.")),
        }
    }
    Ok(positions)
}

fn snapshot_ids(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if text.starts_with("snap_") => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| snapshot_ids(item, out)),
        Value::Object(fields) => fields.values().for_each(|field| snapshot_ids(field, out)),
        _ => {}
    }
}

/// Why a member cannot be removed now.
#[derive(Clone, Debug)]
pub(crate) enum Blocker {
    Used(Vec<Use>),
    /// Members saved later that name this one as their parent.
    Children(Vec<Member>),
    /// A live sandbox builds on it.
    Lineage(String),
}

/// Removal order for `candidates`: leaves first, so each removal passes MicroSandbox's
/// children guard. Members something depends on are kept with the reason.
pub(crate) struct Plan {
    pub(crate) remove: Vec<Member>,
    pub(crate) kept: Vec<(Member, Blocker)>,
}

pub(crate) fn plan(
    inventory: &[Member],
    candidates: &HashSet<Key>,
    uses: &HashMap<Key, Vec<Use>>,
    positions: &HashMap<String, String>,
) -> Plan {
    let mut kept = Vec::new();
    let mut pending = Vec::new();
    for member in inventory.iter().filter(|member| member.key().is_some_and(|key| candidates.contains(&key))) {
        let key = member.key().unwrap();
        if let Some(used) = uses.get(&key).filter(|used| !used.is_empty()) {
            kept.push((member.clone(), Blocker::Used(used.clone())));
        } else if let Some(sandbox) = positions.get(&member.snapshot_id) {
            kept.push((member.clone(), Blocker::Lineage(sandbox.clone())));
        } else {
            pending.push(member.clone());
        }
    }
    let mut present: HashSet<&str> = inventory.iter().map(|member| member.snapshot_id.as_str()).collect();
    let mut remove = Vec::new();
    loop {
        let before = remove.len();
        let mut index = 0;
        while index < pending.len() {
            let id = pending[index].snapshot_id.clone();
            let has_children = inventory.iter().any(|child| {
                child.parent_digest.as_deref() == Some(id.as_str()) && present.contains(child.snapshot_id.as_str())
            });
            if has_children {
                index += 1;
                continue;
            }
            present.remove(id.as_str());
            remove.push(pending.remove(index));
        }
        if remove.len() == before {
            break;
        }
    }
    for member in pending {
        let children = inventory
            .iter()
            .filter(|child| child.parent_digest.as_deref() == Some(member.snapshot_id.as_str()) && present.contains(child.snapshot_id.as_str()))
            .cloned()
            .collect();
        kept.push((member, Blocker::Children(children)));
    }
    Plan { remove, kept }
}

const REMOVE_TIMEOUT: Duration = Duration::from_secs(300);

/// Remove members in plan order. A group's current head is moved to a surviving member
/// first, since MicroSandbox refuses to remove a head while other members remain.
/// Returns each failure; later members still run (a failed child keeps its parent).
pub(crate) fn execute(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    inventory: &[Member],
    order: &[Member],
) -> Vec<(Member, RuntimeError)> {
    let mut removed: HashSet<String> = HashSet::new();
    let mut failures = Vec::new();
    for member in order {
        let Some((group, name)) = member.key() else { continue };
        let head = runner
            .run(paths, &["snapshot".into(), "head".into(), group.clone(), "--format".into(), "json".into()], READ_TIMEOUT)
            .ok()
            .and_then(|output| serde_json::from_str::<Value>(&output.stdout).ok())
            .and_then(|value| value["head"].as_str().map(str::to_owned));
        if head.as_deref() == Some(member.snapshot_id.as_str()) {
            // Prefer a member that stays (its parent, then the newest); otherwise one that is
            // removed later, which is then moved again or removed as the group's last member.
            let others: Vec<&Member> = inventory
                .iter()
                .filter(|other| {
                    other.group.as_deref() == Some(group.as_str())
                        && other.snapshot_id != member.snapshot_id
                        && !removed.contains(&other.snapshot_id)
                })
                .collect();
            let queued = |other: &&&Member| order.iter().any(|entry| entry.snapshot_id == other.snapshot_id);
            let staying: Vec<&Member> = others.iter().filter(|other| !queued(other)).copied().collect();
            let pool = if staying.is_empty() { others } else { staying };
            let next = pool
                .iter()
                .find(|other| member.parent_digest.as_deref() == Some(other.snapshot_id.as_str()))
                .or_else(|| pool.iter().max_by(|a, b| a.created_at.cmp(&b.created_at)));
            if let Some(next) = next {
                if let Err(failure) = runner.run(
                    paths,
                    &["snapshot".into(), "head".into(), format!("{group}:{}", next.snapshot_id), "--format".into(), "json".into()],
                    READ_TIMEOUT,
                ) {
                    failures.push((member.clone(), failure));
                    continue;
                }
            }
        }
        match runner.run(
            paths,
            &["snapshot".into(), "remove".into(), format!("{group}:{name}"), "--quiet".into()],
            REMOVE_TIMEOUT,
        ) {
            Ok(_) => {
                removed.insert(member.snapshot_id.clone());
            }
            Err(failure) => failures.push((member.clone(), failure)),
        }
    }
    failures
}

/// Members Silo created itself: checkpoint captures (`c` + 31 hex) and export captures.
pub(crate) fn silo_member(key: &Key) -> bool {
    let (group, name) = key;
    if !valid_snapshot_group(group) {
        return false;
    }
    if is_checkpoint_native_id(name) {
        return true;
    }
    let Some(suffix) = name.strip_prefix("silo-backup-") else { return false };
    let parts: Vec<_> = suffix.split('-').collect();
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Host allocation of a member's artifact directory, when it lies inside the runtime's
/// snapshot store. Symlinks are never followed.
pub(crate) fn artifact_bytes(paths: &RuntimePaths, member: &Member) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    let root = fs::canonicalize(paths.home.join("snapshots")).ok()?;
    let artifact = fs::canonicalize(member.artifact_path.as_deref()?).ok()?;
    if !artifact.starts_with(&root) || artifact == root {
        return None;
    }
    let mut total = 0u64;
    let mut stack = vec![(artifact, 0usize)];
    let mut visited = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        for entry in fs::read_dir(&directory).ok()? {
            visited += 1;
            if visited > 100_000 {
                return None;
            }
            let entry = entry.ok()?;
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            if metadata.is_file() {
                total = total.saturating_add(metadata.blocks().saturating_mul(512));
            } else if metadata.is_dir() && depth < 8 {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    Some(total)
}

/// Seconds since the member was created, when the runtime reported a valid time.
pub(crate) fn age_seconds(member: &Member, now: SystemTime) -> Option<u64> {
    let created = time::OffsetDateTime::parse(
        member.created_at.as_deref()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    let now = time::OffsetDateTime::from(now);
    u64::try_from((now - created).whole_seconds()).ok()
}
