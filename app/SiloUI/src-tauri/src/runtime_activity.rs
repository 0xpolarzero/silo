use super::*;

const LIMIT: usize = 200;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Event {
    id: String,
    action: String,
    workspace: String,
    timestamp: u64,
    completed: bool,
    failure: Option<String>,
    process: u32,
}

fn path(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("sandbox-activity.json")
}

fn events(paths: &RuntimePaths) -> Result<Vec<Event>, RuntimeError> {
    let file = match File::open(path(paths)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => {
            return Err(RuntimeError::Unavailable(
                "Sandbox activity could not be read.".into(),
            ))
        }
    };
    let events: Vec<Event> = serde_json::from_reader(file.take(MAX_OUTPUT_BYTES))
        .map_err(|_| RuntimeError::Malformed("Sandbox activity could not be decoded.".into()))?;
    if events.len() > LIMIT
        || events.iter().any(|event| {
            validate_name(&event.workspace).is_err()
                || !matches!(event.action.as_str(), "start" | "stop" | "restart")
        })
    {
        return Err(RuntimeError::Malformed(
            "Sandbox activity is invalid.".into(),
        ));
    }
    Ok(events)
}

fn store(paths: &RuntimePaths, event: &Event) -> Result<(), String> {
    let mut entries = events(paths).map_err(|error| error.to_string())?;
    entries.retain(|old| old.id != event.id);
    entries.push(event.clone());
    if entries.len() > LIMIT {
        entries.remove(0);
    }
    let target = path(paths);
    let parent = target
        .parent()
        .ok_or("Sandbox activity storage is unavailable.")?;
    fs::create_dir_all(parent).map_err(|_| "Sandbox activity storage is unavailable.")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Sandbox activity could not be saved.")?;
    serde_json::to_writer(&mut file, &entries)
        .map_err(|_| "Sandbox activity could not be saved.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Sandbox activity could not be saved.")?;
    file.persist(&target)
        .map_err(|_| "Sandbox activity could not be saved.")?;
    File::open(parent).and_then(|file| file.sync_all())
        .map_err(|_| "Sandbox activity could not be synced.".to_string())
}

pub(super) fn begin(paths: &RuntimePaths, action: &str, workspace: &str) -> Result<Event, String> {
    validate_name(workspace).map_err(|error| error.to_string())?;
    if !matches!(action, "start" | "stop" | "restart") {
        return Err("Unknown sandbox action.".into());
    }
    let timestamp = activity_timestamp();
    let event = Event {
        id: format!(
            "lifecycle-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ),
        action: action.into(),
        workspace: workspace.into(),
        timestamp,
        completed: false,
        failure: None,
        process: std::process::id(),
    };
    store(paths, &event)?;
    Ok(event)
}

pub(super) fn matches(event: &Event, action: &str, workspace: &str) -> bool {
    event.action == action && event.workspace == workspace
}

pub(super) fn resume(paths: &RuntimePaths, event: &mut Event) -> Result<(), String> {
    event.process = std::process::id();
    event.completed = false;
    event.failure = None;
    store(paths, event)
}

pub(super) fn finish(
    paths: &RuntimePaths,
    event: &mut Event,
    result: &Result<(), RuntimeError>,
) -> Result<(), String> {
    event.completed = true;
    event.failure = result.as_ref().err().map(safe_activity_error);
    store(paths, event)
}

fn timestamp(value: u64) -> String {
    let date = time::OffsetDateTime::from_unix_timestamp((value / 1000) as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.year(),
        u8::from(date.month()),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        value % 1000
    )
}

fn history_warning(kind: &str) -> Value {
    serde_json::json!({"id": format!("{kind}-history-unavailable"), "category": "system", "title": "Activity history unavailable", "detail": format!("Silo could not read its {kind} activity history."), "occurredAt": timestamp(activity_timestamp()), "time": timestamp(activity_timestamp()), "tone": "warning", "status": "completed"})
}

pub(super) fn read(paths: &RuntimePaths) -> Result<Vec<Value>, RuntimeError> {
    let mut warnings = Vec::new();
    let mut result: Vec<Value> = read_activity(paths, false).unwrap_or_else(|_| { warnings.push(history_warning("setup")); Vec::new() }).into_iter().enumerate().map(|(index, event)| {
        serde_json::json!({"id": format!("setup-{}-{}-{}-{index}", event.request_id, event.timestamp, event.step), "category": "sandbox", "title": event.message, "detail": "Sandbox setup", "occurredAt": timestamp(event.timestamp), "time": timestamp(event.timestamp), "tone": if event.level == "error" { "danger" } else if event.level == "warning" { "warning" } else { "neutral" }, "status": "completed", "workspace": event.workspace})
    }).collect();
    result.extend(events(paths).unwrap_or_else(|_| { warnings.push(history_warning("sandbox")); Vec::new() }).into_iter().map(|event| {
        let interrupted = !event.completed && event.process != std::process::id();
        let failed = event.failure.is_some();
        let title = match (event.action.as_str(), event.completed, failed) {
            ("start", true, false) => "Sandbox started", ("stop", true, false) => "Sandbox stopped", ("restart", true, false) => "Sandbox restarted",
            ("start", _, _) => "Starting sandbox", ("stop", _, _) => "Stopping sandbox", _ => "Restarting sandbox",
        };
        serde_json::json!({"id": event.id, "category": "sandbox", "title": if failed { format!("{title} failed") } else { title.into() }, "detail": if interrupted { "Silo closed before the result was verified. Check the sandbox state.".into() } else { event.failure.unwrap_or_else(|| if event.completed { "Runtime state verified.".into() } else { "Waiting for the runtime…".into() }) }, "occurredAt": timestamp(event.timestamp), "time": timestamp(event.timestamp), "tone": if interrupted { "warning" } else if failed { "danger" } else if event.completed { "success" } else { "neutral" }, "status": if event.completed || interrupted { "completed" } else { "running" }, "workspace": event.workspace})
    }));
    result.extend(warnings);
    result.sort_by(|a, b| b["occurredAt"].as_str().cmp(&a["occurredAt"].as_str()));
    result.truncate(LIMIT);
    Ok(result)
}

pub(super) fn strip_ansi(text: &str) -> String {
    let mut chars = text.chars();
    let mut clean = String::with_capacity(text.len());
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' { clean.push(ch); continue; }
        match chars.next() {
            Some('[') => { for ch in chars.by_ref() { if ('@'..='~').contains(&ch) { break; } } }
            Some(']') => {
                let mut escape = false;
                for ch in chars.by_ref() {
                    if ch == '\u{7}' || (escape && ch == '\\') { break; }
                    escape = ch == '\u{1b}';
                }
            }
            Some(_) | None => {}
        }
    }
    clean
}

pub(super) fn log_text(body: &str) -> String {
    strip_ansi(body).lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "authorization",
                "bearer ",
                "ghp_",
                "ghs_",
                "ghu_",
                "ghr_",
                "github_pat_",
                "password=",
                "password\":",
                "secret=",
                "secret\":",
                "token=",
                "token\":",
                "private key",
                "environment:",
                "\"env\"",
            ]
            .iter()
            .any(|marker| lower.contains(marker))
            {
                "[Sensitive runtime output hidden]".into()
            } else {
                line.chars()
                    .filter(|ch| !ch.is_control() || *ch == '\t')
                    .collect::<String>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_lifecycle_records_verified_results_without_raw_failure_output() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut event = begin(&paths, "restart", "dev").unwrap();
        assert_eq!(read(&paths).unwrap()[0]["status"], "running");
        finish(
            &paths,
            &mut event,
            &Err(RuntimeError::Failed {
                operation: "Restarting the sandbox".into(),
                detail: "exit code 1: TOKEN=private-value".into(),
            }),
        )
        .unwrap();
        let values = read(&paths).unwrap();
        assert_eq!(values[0]["tone"], "danger");
        assert!(!serde_json::to_string(&values)
            .unwrap()
            .contains("private-value"));
        assert_eq!(values[0]["status"], "completed");
    }
    #[test]
    fn unfinished_previous_process_is_not_reported_running_or_successful() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut event = begin(&paths, "stop", "dev").unwrap();
        event.process = 0;
        store(&paths, &event).unwrap();
        let values = read(&paths).unwrap();
        assert_eq!(values[0]["tone"], "warning");
        assert_eq!(values[0]["status"], "completed");
    }
}
