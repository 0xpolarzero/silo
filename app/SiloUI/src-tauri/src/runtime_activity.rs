use super::*;

const LIMIT: usize = 200;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Event {
    id: String,
    action: String,
    workspace: String,
    #[serde(default)]
    machine_id: String,
    timestamp: u64,
    completed: bool,
    failure: Option<String>,
    #[serde(default)]
    dismissed: bool,
    /// The user cancelled the action; it is neither a failure nor a success.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    cancelled: bool,
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
    let mut events: Vec<Event> = serde_json::from_reader(file.take(MAX_OUTPUT_BYTES))
        .map_err(|_| RuntimeError::Malformed("Sandbox activity could not be decoded.".into()))?;
    // Entries from another build (a newer action, an over-long journal) only
    // cost history; they must not stop start/stop from journaling.
    events.retain(|event| {
        validate_name(&event.workspace).is_ok()
            && matches!(event.action.as_str(), "start" | "stop" | "restart")
    });
    if events.len() > LIMIT { events.drain(..events.len() - LIMIT); }
    Ok(events)
}

fn store(paths: &RuntimePaths, event: &Event) -> Result<(), String> {
    let mut entries = events(paths).map_err(|error| error.to_string())?;
    entries.retain(|old| old.id != event.id);
    entries.push(event.clone());
    if entries.len() > LIMIT {
        entries.remove(0);
    }
    // Detailed failures must not make the journal exceed its own read limit.
    let sizes: Vec<usize> = entries.iter().map(|entry| serde_json::to_vec(entry).map(|bytes| bytes.len() + 1))
        .collect::<Result<_, _>>().map_err(|_| "Sandbox activity could not be saved.")?;
    let mut bytes = 1 + sizes.iter().sum::<usize>();
    let mut drop_count = 0;
    while bytes > MAX_OUTPUT_BYTES as usize && drop_count + 1 < entries.len() {
        bytes -= sizes[drop_count];
        drop_count += 1;
    }
    if bytes > MAX_OUTPUT_BYTES as usize { return Err("Sandbox activity is too large to save.".into()); }
    entries.drain(..drop_count);
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

pub(super) fn begin(paths: &RuntimePaths, action: &str, workspace: &str, machine_id: &str) -> Result<Event, String> {
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
        machine_id: machine_id.into(),
        timestamp,
        completed: false,
        failure: None,
        dismissed: false,
        cancelled: false,
        process: std::process::id(),
    };
    store(paths, &event)?;
    Ok(event)
}

pub(super) fn matches(event: &Event, action: &str, workspace: &str) -> bool {
    event.action == action && event.workspace == workspace
}

pub(super) fn resume(paths: &RuntimePaths, event: &mut Event, machine_id: &str) -> Result<(), String> {
    event.machine_id = machine_id.into();
    event.process = std::process::id();
    event.completed = false;
    event.failure = None;
    event.dismissed = false;
    event.cancelled = false;
    store(paths, event)
}

pub(super) fn finish(
    paths: &RuntimePaths,
    event: &mut Event,
    result: &Result<(), RuntimeError>,
) -> Result<(), String> {
    event.completed = true;
    event.cancelled = matches!(result, Err(RuntimeError::Cancelled { .. }));
    event.failure = result.as_ref().err().filter(|_| !event.cancelled).map(failure_message);
    store(paths, event)
}

/// Settle an action that is being retired without running (D-22): an unfinished
/// entry becomes cancelled; a finished one (for example a failed start kept for
/// Retry) keeps its recorded outcome.
pub(super) fn retire(paths: &RuntimePaths, event: &mut Event) -> Result<(), String> {
    // A saved action holds the entry as it was when saved; the journal has its outcome.
    let journaled = events(paths).map_err(|error| error.to_string())?
        .into_iter().find(|entry| entry.id == event.id);
    if event.completed || journaled.is_some_and(|entry| entry.completed) {
        return Ok(());
    }
    let operation = format!("{} {}", event.action, event.workspace);
    finish(paths, event, &Err(RuntimeError::Cancelled { operation }))
}

pub(super) fn failure_message(error: &RuntimeError) -> String {
    let summary = safe_activity_error(error);
    let RuntimeError::Failed { detail, .. } = error else { return summary };
    // Keep the runtime's explanation, using the same sensitive-output filtering
    // as Logs. Bound the journal and IPC payload even for noisy CLI failures.
    let diagnostic = log_text(detail);
    let diagnostic = diagnostic.trim();
    if diagnostic.is_empty() { return summary; }
    let bounded: String = diagnostic.chars().take(8_192).collect();
    format!("{summary}\n{bounded}{}", if bounded.len() < diagnostic.len() { "\n[Diagnostic truncated]" } else { "" })
}

pub(super) fn failures(paths: &RuntimePaths) -> Result<HashMap<String, String>, RuntimeError> {
    let mut latest = HashMap::new();
    for event in events(paths)? {
        // Legacy records remain in Activity, but cannot be attributed safely to
        // a current VM: names can be reused after deletion or restoration.
        if !event.machine_id.is_empty() { latest.insert(event.machine_id.clone(), event); }
    }
    Ok(latest.into_iter().filter_map(|(name, event)| {
        let label = match event.action.as_str() { "start" => "Start", "stop" => "Stop", _ => "Restart" };
        event.failure.filter(|_| !event.dismissed).map(|message| (name, format!("{label} failed: {message}")))
    }).collect())
}

pub(super) fn acknowledge_failure(paths: &RuntimePaths, machine_id: &str) -> Result<(), RuntimeError> {
    if let Some(mut event) = events(paths)?.into_iter().rev().find(|event| event.machine_id == machine_id) {
        event.dismissed = true;
        store(paths, &event).map_err(RuntimeError::Unavailable)?;
    }
    Ok(())
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
        if event.cancelled {
            let title = match event.action.as_str() { "start" => "Start cancelled", "stop" => "Stop cancelled", _ => "Restart cancelled" };
            return serde_json::json!({"id": event.id, "category": "sandbox", "title": title, "detail": "The action was cancelled.", "occurredAt": timestamp(event.timestamp), "time": timestamp(event.timestamp), "tone": "neutral", "status": "completed", "workspace": event.workspace, "cancelled": true});
        }
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

/// Remove terminal control sequences (7- and 8-bit CSI, OSC/DCS/APC/PM/SOS
/// strings) and every other C0/C1 control except tab and newline, so exported
/// logs cannot drive a terminal (CR/BS overwrites, colours, titles).
pub(super) fn strip_ansi(text: &str) -> String {
    fn skip_string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
        while let Some(ch) = chars.next() {
            if ch == '\u{7}' || ch == '\u{9c}' { break; }
            if ch == '\u{1b}' && chars.peek() == Some(&'\\') { chars.next(); break; }
        }
    }
    let mut chars = text.chars().peekable();
    let mut clean = String::with_capacity(text.len());
    while let Some(ch) = chars.next() {
        let introducer = match ch {
            '\u{1b}' => match chars.next() {
                Some('[') => '\u{9b}',
                Some(']') => '\u{9d}',
                Some('P') => '\u{90}',
                Some('X') => '\u{98}',
                Some('^') => '\u{9e}',
                Some('_') => '\u{9f}',
                _ => continue,
            },
            ch => ch,
        };
        match introducer {
            '\u{9b}' => { for ch in chars.by_ref() { if ('@'..='~').contains(&ch) { break; } } }
            '\u{9d}' | '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => skip_string(&mut chars),
            '\t' | '\n' => clean.push(introducer),
            ch if ch.is_control() => {}
            ch => clean.push(ch),
        }
    }
    clean
}

/// A secret-looking assignment: `secret`, `token`, `key`, `passw` or
/// `credential` followed by optional word characters and quotes, then `:` or
/// `=` (for example `AWS_SECRET_ACCESS_KEY=`, `api_key =`, `"password": `).
fn sensitive_assignment(lower: &str) -> bool {
    ["secret", "token", "key", "passw", "credential"].iter().any(|word| {
        lower.match_indices(word).any(|(at, _)| {
            let rest = lower[at + word.len()..].trim_start_matches(|ch: char| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
            let rest = rest.trim_start_matches(['"', '\'']).trim_start();
            rest.starts_with(':') || rest.starts_with('=')
        })
    })
}

pub(super) fn log_text(body: &str) -> String {
    let mut in_pem = false;
    strip_ansi(body).lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            // Hide whole PEM blocks, not only their BEGIN line.
            if lower.contains("-----begin") { in_pem = true; }
            let pem = in_pem;
            if lower.contains("-----end") { in_pem = false; }
            if pem || sensitive_assignment(&lower) || [
                "authorization",
                "bearer ",
                "ghp_",
                "ghs_",
                "ghu_",
                "ghr_",
                "github_pat_",
                "private key",
                "environment:",
                "\"env\"",
            ]
            .iter()
            .any(|marker| lower.contains(marker))
            {
                "[Sensitive runtime output hidden]".into()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_text_hides_common_secret_assignments_and_pem_blocks() {
        for line in ["AWS_SECRET_ACCESS_KEY=abc", "api_key = abc", "Password: hunter2", "PASSWORD =x", "\"client_secret\": \"abc\"", "export GH_TOKEN=abc"] {
            assert_eq!(log_text(line), "[Sensitive runtime output hidden]", "{line}");
        }
        let pem = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nafter";
        let text = log_text(pem);
        assert!(!text.contains("b3BlbnNzaC1rZXk"));
        assert!(text.starts_with("before\n") && text.ends_with("\nafter"));
        assert_eq!(log_text("VM started in 2s"), "VM started in 2s");
    }

    #[test]
    fn strip_ansi_removes_8bit_and_string_controls() {
        assert_eq!(strip_ansi("a\u{9b}31mb"), "ab");
        assert_eq!(strip_ansi("a\u{1b}P1;2|payload\u{1b}\\b"), "ab");
        assert_eq!(strip_ansi("a\u{1b}_apc\u{9c}b\u{1b}]0;title\u{7}c"), "abc");
        assert_eq!(strip_ansi("safe\rhidden\u{8}\u{8}x\tt\nn"), "safehiddenx\tt\nn");
    }
    #[test]
    fn cancelled_action_is_persisted_as_cancelled_not_failed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut event = begin(&paths, "start", "dev", "vm-1").unwrap();
        finish(&paths, &mut event, &Err(RuntimeError::Cancelled { operation: "start dev".into() })).unwrap();
        assert!(failures(&paths).unwrap().is_empty());
        let entry = &read(&paths).unwrap()[0];
        assert_eq!(entry["title"], "Start cancelled");
        assert_eq!(entry["tone"], "neutral");
        assert_eq!(entry["cancelled"], true);
    }

    #[test]
    fn unknown_or_excess_entries_do_not_block_journaling() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut first = begin(&paths, "start", "dev", "vm-1").unwrap();
        finish(&paths, &mut first, &Ok(())).unwrap();
        let mut entries: Vec<Value> = serde_json::from_slice(&fs::read(path(&paths)).unwrap()).unwrap();
        let mut unknown = entries[0].clone();
        unknown["action"] = "hibernate".into();
        unknown["id"] = "future".into();
        entries.push(unknown);
        while entries.len() <= LIMIT + 5 { let mut copy = entries[0].clone(); copy["id"] = format!("old-{}", entries.len()).into(); entries.push(copy); }
        fs::write(path(&paths), serde_json::to_vec(&entries).unwrap()).unwrap();
        let mut next = begin(&paths, "stop", "dev", "vm-1").unwrap();
        finish(&paths, &mut next, &Ok(())).unwrap();
        let stored = events(&paths).unwrap();
        assert!(stored.len() <= LIMIT);
        assert!(stored.iter().all(|event| event.action != "hibernate"));
        assert!(stored.iter().any(|event| event.id == next.id));
    }
    #[test]
    fn lifecycle_failure_keeps_diagnostics_and_survives_read_until_success() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut event = begin(&paths, "start", "dev", "vm-1").unwrap();
        finish(&paths, &mut event, &Err(RuntimeError::Failed {
            operation: "Starting the sandbox".into(),
            detail: "exit code 1: \u{1b}[31mlibkrunfw could not load: different Team IDs\u{1b}[0m\nTOKEN=private-value".into(),
        })).unwrap();
        let detail = read(&paths).unwrap()[0]["detail"].as_str().unwrap().to_string();
        assert!(detail.contains("libkrunfw could not load: different Team IDs"));
        assert!(!detail.contains("private-value"));
        assert!(!detail.contains('\u{1b}'));
        assert!(failures(&paths).unwrap()["vm-1"].contains("different Team IDs"));
        assert!(!failures(&paths).unwrap().contains_key("replacement-vm"));
        let mut retry = begin(&paths, "start", "dev", "vm-1").unwrap();
        finish(&paths, &mut retry, &Ok(())).unwrap();
        assert!(!failures(&paths).unwrap().contains_key("vm-1"));
        assert!(read(&paths).unwrap().iter().any(|entry| entry["detail"].as_str().is_some_and(|text| text.contains("different Team IDs"))));
    }

    #[test]
    fn durable_lifecycle_records_verified_results_without_raw_failure_output() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut event = begin(&paths, "restart", "dev", "vm-1").unwrap();
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
        let mut event = begin(&paths, "stop", "dev", "vm-1").unwrap();
        event.process = 0;
        store(&paths, &event).unwrap();
        let values = read(&paths).unwrap();
        assert_eq!(values[0]["tone"], "warning");
        assert_eq!(values[0]["status"], "completed");
    }

    #[test]
    fn acknowledging_a_failure_preserves_activity_but_clears_overview() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut event = begin(&paths, "start", "dev", "vm-1").unwrap();
        finish(&paths, &mut event, &Err(RuntimeError::Invalid("Boot failed".into()))).unwrap();
        acknowledge_failure(&paths, "replacement-vm").unwrap();
        assert!(failures(&paths).unwrap().contains_key("vm-1"));
        acknowledge_failure(&paths, "vm-1").unwrap();
        assert!(failures(&paths).unwrap().is_empty());
        assert_eq!(read(&paths).unwrap()[0]["detail"], "Boot failed");
    }

    #[test]
    fn detailed_failure_retention_stays_within_the_journal_read_limit() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut event = begin(&paths, "start", "dev", "vm-1").unwrap();
        event.completed = true;
        event.failure = Some("failure detail ".repeat(500));
        let entries: Vec<_> = (0..133).map(|index| { let mut entry = event.clone(); entry.id = index.to_string(); entry }).collect();
        fs::write(path(&paths), serde_json::to_vec(&entries).unwrap()).unwrap();
        finish(&paths, &mut event, &Err(RuntimeError::Failed {
            operation: "Starting the sandbox".into(), detail: "💥".repeat(20_000),
        })).unwrap();
        assert!(fs::metadata(path(&paths)).unwrap().len() <= MAX_OUTPUT_BYTES);
        assert!(events(&paths).unwrap().len() < 134);
        assert!(events(&paths).unwrap().last().unwrap().failure.as_ref().unwrap().contains("[Diagnostic truncated]"));
    }
}
