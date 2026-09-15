//! Acknowledged push jobs belong to the host, not the SSH connection observing them.
use crate::{host_push, remote, remote_access, runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

static LOCK: Mutex<()> = Mutex::new(());
static SESSION: OnceLock<String> = OnceLock::new();
static COMPLETED: OnceLock<Mutex<HashMap<String, (Value, u64)>>> = OnceLock::new();
fn session() -> &'static str {
    SESSION.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}
#[derive(Clone, Serialize, Deserialize)]
struct Job {
    session: String,
    updated: u64,
    dismissed: bool,
    operation: Value,
}
type Journal = HashMap<String, Job>;
const MAX_JOBS: usize = 10_000;
const MAX_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
fn read(path: &Path) -> Result<Journal, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err("Cannot read saved push operations.".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read saved push operations.")?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(
            "Saved push history exceeds its 16 MiB safety limit. No new push was started.".into(),
        );
    }
    let mut jobs: Journal =
        serde_json::from_slice(&bytes).map_err(|_| "Cannot read saved push operations.")?;
    // If recording completion failed (for example a full disk), the live host
    // still reports the real result. A restart retains the honest unknown state.
    if let Some(completed) = COMPLETED.get() {
        if let Ok(completed) = completed.lock() {
            for (id, (value, updated)) in completed.iter() {
                if let Some(job) = jobs.get_mut(id) {
                    job.operation = value.clone();
                    job.updated = *updated;
                }
            }
        }
    }
    Ok(jobs)
}
fn write(path: &Path, jobs: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec(jobs).map_err(|_| "Cannot encode push operations.")?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(
            "Saved push history reached its 16 MiB safety limit. No new push was started.".into(),
        );
    }
    let parent = path.parent().ok_or("Cannot locate push operations.")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot save push operations.")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot save push operations.")?;
    temporary
        .write_all(&bytes)
        .map_err(|_| "Cannot save push operations.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Cannot save push operations.")?;
    temporary
        .persist(path)
        .map_err(|_| "Cannot save push operations.")?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "Cannot save push operations.".to_string())
}
fn operation(job: &Job) -> Value {
    let mut value = job.operation.clone();
    if value["status"] == "pushing" && job.session != session() {
        value["status"] = json!("unknown");
        value["message"] = json!("Silo restarted before recording the result. Check this branch on GitHub before retrying.");
    }
    value
}
fn claim(
    jobs: &mut Journal,
    id: &str,
    workspace: &str,
    path: &str,
) -> Result<(Value, bool), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid push operation identifier.")?;
    if let Some(job) = jobs.get(id) {
        if job.operation["workspace"] != workspace || job.operation["repositoryPath"] != path {
            return Err("Push operation identifier belongs to another repository.".into());
        }
        return Ok((operation(job), false));
    }
    if let Some(job) = jobs.values().find(|job| {
        !job.dismissed
            && job.operation["status"] == "pushing"
            && job.operation["workspace"] == workspace
            && job.operation["repositoryPath"] == path
    }) {
        return Ok((operation(job), false));
    }
    if jobs.len() >= MAX_JOBS {
        return Err("Saved push history reached its 10,000-operation safety limit. No new push was started. Contact Silo support to archive the history without replaying previous requests.".into());
    }
    let value = json!({"operationId":id,"workspace":workspace,"repositoryPath":path,"status":"pushing","commitCount":0});
    jobs.insert(
        id.into(),
        Job {
            session: session().into(),
            updated: now(),
            dismissed: false,
            operation: value.clone(),
        },
    );
    Ok((value, true))
}
pub(crate) fn start(
    app: &AppHandle,
    workspace: String,
    path: String,
    id: String,
) -> Result<Value, String> {
    let journal = runtime::runtime_paths(app)?
        .home
        .join("repository-push-operations.json");
    let _guard = LOCK.lock().map_err(|_| "Push state unavailable.")?;
    let mut jobs = read(&journal)?;
    let (value, created) = claim(&mut jobs, &id, &workspace, &path)?;
    if !created {
        return Ok(value);
    }
    // Persist before acknowledging or starting: retrying a lost reply never starts a second job.
    write(&journal, &jobs)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = host_push::push_repository(app.clone(), workspace.clone(), path.clone()).await;
        let mut value = result.unwrap_or_else(|message| json!({"workspace":workspace,"repositoryPath":path,"status":"failed","commitCount":0,"message":message}));
        value["operationId"] = json!(id);
        if let Ok(_guard) = LOCK.lock() {
            if let Ok(mut completed) = COMPLETED.get_or_init(|| Mutex::new(HashMap::new())).lock() {
                completed.insert(id.clone(), (value.clone(), now()));
            }
            if let Ok(mut jobs) = read(&journal) {
                if let Some(job) = jobs.get_mut(&id) {
                    job.operation = value;
                    job.updated = now();
                }
                // A failed save leaves the previous durable record unresolved, never a fabricated success.
                let _ = write(&journal, &jobs);
            }
        }
        let _ = app.emit("silo://application-state-changed", ());
    });
    Ok(value)
}
pub(crate) fn status(
    app: &AppHandle,
    workspace: &str,
    path: &str,
    id: &str,
) -> Result<Value, String> {
    let _guard = LOCK.lock().map_err(|_| "Push state unavailable.")?;
    let jobs = read(
        &runtime::runtime_paths(app)?
            .home
            .join("repository-push-operations.json"),
    )?;
    let Some(job) = jobs.get(id) else {
        return Ok(Value::Null);
    };
    if job.operation["workspace"] != workspace || job.operation["repositoryPath"] != path {
        return Err("Push operation identifier belongs to another repository.".into());
    }
    Ok(operation(job))
}
pub(crate) fn merge(app: &AppHandle, legacy: Vec<Value>) -> Result<Vec<Value>, String> {
    let _guard = LOCK.lock().map_err(|_| "Push state unavailable.")?;
    let jobs = read(
        &runtime::runtime_paths(app)?
            .home
            .join("repository-push-operations.json"),
    )?;
    let mut latest = HashMap::<String, &Job>::new();
    for job in jobs.values() {
        let key = format!(
            "{}\0{}",
            job.operation["workspace"], job.operation["repositoryPath"]
        );
        if latest
            .get(&key)
            .is_none_or(|old| old.updated <= job.updated)
        {
            latest.insert(key, job);
        }
    }
    // Older clients still use the synchronous endpoint. Its active work must
    // remain visible even when this repository has an older durable result.
    for value in &legacy {
        let key = format!("{}\0{}", value["workspace"], value["repositoryPath"]);
        if value["status"] == "pushing"
            && latest
                .get(&key)
                .is_some_and(|job| operation(job)["status"] != "pushing")
        {
            latest.remove(&key);
        }
    }
    let mut values: Vec<_> = legacy
        .into_iter()
        .filter(|value| {
            !latest.contains_key(&format!(
                "{}\0{}",
                value["workspace"], value["repositoryPath"]
            ))
        })
        .collect();
    values.extend(
        latest
            .values()
            .filter(|job| {
                !job.dismissed
                    && (job.operation["status"] != "succeeded"
                        || now().saturating_sub(job.updated) < 4_000_000_000)
            })
            .map(|job| operation(job)),
    );
    Ok(values)
}
pub(crate) fn dismiss(app: &AppHandle, workspace: &str, path: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "Push state unavailable.")?;
    let journal = runtime::runtime_paths(app)?
        .home
        .join("repository-push-operations.json");
    let mut jobs = read(&journal)?;
    for job in jobs.values_mut().filter(|job| {
        job.operation["workspace"] == workspace && job.operation["repositoryPath"] == path
    }) {
        if operation(job)["status"] != "pushing" {
            job.dismissed = true;
        }
    }
    write(&journal, &jobs)
}
// Preparation failures are authoritative: no detached job was dispatched.
// Return them as results so a caller can distinguish them from a lost SSH reply.
pub(crate) fn start_result(app: &AppHandle, workspace: String, path: String, id: String) -> Value {
    start(app, workspace.clone(), path.clone(), id.clone()).unwrap_or_else(|message| json!({"operationId":id,"workspace":workspace,"repositoryPath":path,"status":"failed","commitCount":0,"message":message}))
}
#[tauri::command]
pub async fn start_repository_push(
    app: AppHandle,
    workspace: String,
    repository_path: String,
    operation_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((host, vm)) = remote_access::target(&workspace)? {
            match remote::call_remote(
                &app,
                &host,
                "repository.push.start",
                json!({"vmId":vm,"path":repository_path,"operationId":operation_id}),
            ) {
                Err(message) if message == "This Silo version does not support that remote operation." => Ok(json!({"operationId":operation_id,"workspace":workspace,"repositoryPath":repository_path,"status":"failed","commitCount":0,"message":"Update Silo on the remote computer before pushing."})),
                result => result,
            }
        } else {
            Ok(start_result(&app, workspace, repository_path, operation_id))
        }
    })
    .await
    .map_err(|_| "Cannot start observing the push.".to_string())?
}
#[tauri::command]
pub async fn repository_push_status(
    app: AppHandle,
    workspace: String,
    repository_path: String,
    operation_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((host, vm)) = remote_access::target(&workspace)? {
            remote::call_remote(
                &app,
                &host,
                "repository.push.status",
                json!({"vmId":vm,"path":repository_path,"operationId":operation_id}),
            )
        } else {
            status(&app, &workspace, &repository_path, &operation_id)
        }
    })
    .await
    .map_err(|_| "Cannot read push status.".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lost_acknowledgement_and_concurrent_clicks_share_one_job() {
        let mut jobs = Journal::new();
        let id = uuid::Uuid::new_v4().to_string();
        assert!(claim(&mut jobs, &id, "dev", "/workspace/repo").unwrap().1);
        assert!(!claim(&mut jobs, &id, "dev", "/workspace/repo").unwrap().1);
        let (other, created) = claim(
            &mut jobs,
            &uuid::Uuid::new_v4().to_string(),
            "dev",
            "/workspace/repo",
        )
        .unwrap();
        assert!(!created);
        assert_eq!(other["operationId"], id);
        assert_eq!(jobs.len(), 1);
        assert!(claim(&mut jobs, &id, "another", "/workspace/repo").is_err());
    }
    #[test]
    fn journal_preserves_results_and_never_replays_after_restart() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("jobs.json");
        let id = uuid::Uuid::new_v4().to_string();
        let mut jobs = Journal::new();
        claim(&mut jobs, &id, "dev", "/workspace/repo").unwrap();
        jobs.get_mut(&id).unwrap().session = "previous-process".into();
        write(&path, &jobs).unwrap();
        let mut recovered = read(&path).unwrap();
        let (result, created) = claim(&mut recovered, &id, "dev", "/workspace/repo").unwrap();
        assert!(!created);
        let (blocked, launched) = claim(
            &mut recovered,
            &uuid::Uuid::new_v4().to_string(),
            "dev",
            "/workspace/repo",
        )
        .unwrap();
        assert!(!launched);
        assert_eq!(blocked["status"], "unknown");
        assert_eq!(result["status"], "unknown");
        assert!(result["message"]
            .as_str()
            .unwrap()
            .contains("Check this branch on GitHub"));
        recovered.get_mut(&id).unwrap().dismissed = true; // Explicit “I’ve checked GitHub”.
        assert!(
            claim(
                &mut recovered,
                &uuid::Uuid::new_v4().to_string(),
                "dev",
                "/workspace/repo"
            )
            .unwrap()
            .1
        );
        recovered.get_mut(&id).unwrap().operation["status"] = json!("succeeded");
        write(&path, &recovered).unwrap();
        assert_eq!(operation(&read(&path).unwrap()[&id])["status"], "succeeded");
    }
    #[test]
    fn history_limits_reject_new_work_but_keep_existing_identifiers() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut jobs = Journal::new();
        claim(&mut jobs, &id, "dev", "/workspace/repo").unwrap();
        let mut finished = jobs[&id].clone();
        finished.operation["status"] = json!("succeeded");
        for index in 1..MAX_JOBS {
            jobs.insert(index.to_string(), finished.clone());
        }
        assert!(!claim(&mut jobs, &id, "dev", "/workspace/repo").unwrap().1);
        assert!(claim(
            &mut jobs,
            &uuid::Uuid::new_v4().to_string(),
            "other",
            "/workspace/repo"
        )
        .unwrap_err()
        .contains("10,000"));
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("oversized.json");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_JOURNAL_BYTES + 1)
            .unwrap();
        assert!(read(&path).err().unwrap().contains("16 MiB"));
    }
}
