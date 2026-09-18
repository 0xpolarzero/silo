//! Bounded, rotation-aware queries over all retained diagnostic files.
use super::*;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::MetadataExt;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Query {
    pub sandbox_id: String,
    pub computer_id: Option<String>,
    pub query: Option<String>,
    pub source: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub around_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub id: String,
    pub line: String,
    pub occurred_at: String,
    pub sandbox_id: String,
    pub sandbox_name: String,
    pub computer_id: String,
    pub computer_name: String,
    pub source: String,
    pub session: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub entries: Vec<Entry>,
    pub next_cursor: Option<String>,
    pub oldest_available_timestamp: Option<String>,
    pub newest_available_timestamp: Option<String>,
    pub total_matches: usize,
    pub timestamp_estimated: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Segment {
    inode: u64,
    bytes: u64,
    stream: String,
    modified: String,
}
#[derive(Serialize, Deserialize)]
struct Snapshot {
    binding: String,
    files: Vec<Segment>,
}
struct Location {
    file: u64,
    offset: u64,
    time: String,
    id: String,
}
struct Cached {
    binding: String,
    files: Vec<Segment>,
    records: Vec<Location>,
    oldest: Option<String>,
    newest: Option<String>,
    estimated: bool,
}
static CACHE: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, (Instant, std::sync::Arc<Cached>)>>,
> = std::sync::OnceLock::new();
fn cache() -> &'static std::sync::Mutex<HashMap<String, (Instant, std::sync::Arc<Cached>)>> {
    CACHE.get_or_init(Default::default)
}
fn cached_page(
    directory: &Path,
    token: &str,
    binding: &str,
    request: &Query,
    sandbox_name: &str,
    computer_id: &str,
    computer_name: &str,
) -> Result<Page, String> {
    let (id, index) = token.split_once(':').ok_or("Invalid log cursor.")?;
    let start: usize = index.parse().map_err(|_| "Invalid log cursor.")?;
    let cached = {
        let mut cache = cache().lock().map_err(|_| "Log query unavailable.")?;
        cache.retain(|_, (seen, _)| seen.elapsed() < Duration::from_secs(1800));
        let (seen, data) = cache
            .get_mut(id)
            .ok_or("Log search expired. Refresh the search.")?;
        if data.binding != binding || start > data.records.len() {
            return Err("The log search changed. Refresh its results.".into());
        }
        *seen = Instant::now();
        data.clone()
    };
    let available = files(directory)?;
    let mut handles = HashMap::new();
    for segment in &cached.files {
        let (path, _) = available
            .iter()
            .find(|(_, s)| {
                s.inode == segment.inode && s.stream == segment.stream && s.bytes >= segment.bytes
            })
            .ok_or("Retained history changed or expired. Refresh the log search.")?;
        let file = File::open(path).map_err(|_| "Retained logs could not be read.")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Retained logs could not be read.")?;
        if metadata.ino() != segment.inode || metadata.len() < segment.bytes {
            return Err("Logs rotated during this request. Refresh the search.".into());
        }
        handles.insert(segment.inode, (BufReader::new(file), segment));
    }
    let mut entries = Vec::new();
    let mut bytes = 0;
    for location in cached
        .records
        .iter()
        .skip(start)
        .take(request.limit.unwrap_or(200).clamp(1, 200))
    {
        let (reader, segment) = handles
            .get_mut(&location.file)
            .ok_or("Retained history expired.")?;
        reader
            .seek(SeekFrom::Start(location.offset))
            .map_err(|_| "Retained log read failed.")?;
        let mut raw_bytes = Vec::new();
        reader
            .by_ref()
            .take(
                segment
                    .bytes
                    .saturating_sub(location.offset)
                    .min(1024 * 1024 + 1),
            )
            .read_until(b'\n', &mut raw_bytes)
            .map_err(|_| "Retained log read failed.")?;
        if record_id(location.file, location.offset, &raw_bytes) != location.id {
            return Err("Retained log data changed or expired. Refresh the search.".into());
        }
        let raw = String::from_utf8_lossy(&raw_bytes);
        let (source, body, session) = if segment.stream == "exec" {
            let value: Value = serde_json::from_str(&raw)
                .map_err(|_| "Retained log data changed. Refresh the search.")?;
            (
                value["s"].as_str().unwrap_or("system").to_string(),
                if value["e"] == "b64" {
                    "[Binary runtime output]".into()
                } else {
                    value["d"].as_str().unwrap_or("").to_string()
                },
                value["id"].as_u64().map(|id| id.to_string()),
            )
        } else {
            (segment.stream.clone(), raw.trim_end().to_string(), None)
        };
        let entry = Entry {
            id: location.id.clone(),
            line: runtime_activity::log_text(&body),
            occurred_at: location.time.clone(),
            sandbox_id: request.sandbox_id.clone(),
            sandbox_name: sandbox_name.into(),
            computer_id: computer_id.into(),
            computer_name: computer_name.into(),
            source,
            session,
        };
        let size = serde_json::to_vec(&entry).map_err(|e| e.to_string())?.len();
        if size > 1024 * 1024 {
            return Err("A log record is too large to display or export.".into());
        }
        if bytes + size > 1024 * 1024 {
            break;
        }
        bytes += size;
        entries.push(entry);
    }
    let next = start + entries.len();
    Ok(Page {
        entries,
        next_cursor: (next < cached.records.len()).then(|| format!("{id}:{next}")),
        oldest_available_timestamp: cached.oldest.clone(),
        newest_available_timestamp: cached.newest.clone(),
        total_matches: cached.records.len(),
        timestamp_estimated: cached.estimated,
    })
}
fn stamp(value: &str) -> Result<String, String> {
    let time = time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map_err(|_| "Invalid log timestamp.".to_string())?
        .to_offset(time::UtcOffset::UTC);
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.nanosecond()
    ))
}
fn files(directory: &Path) -> Result<Vec<(PathBuf, Segment)>, String> {
    let directory = match fs::read_dir(directory) {
        Ok(directory) => directory,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Retained logs could not be read.".into()),
    };
    let mut result = Vec::new();
    for file in directory {
        let file = file.map_err(|_| "Retained logs could not be read.")?;
        let name = file.file_name().to_string_lossy().into_owned();
        let Some(stream) = ["exec", "runtime", "kernel"].into_iter().find(|stream| {
            let base = format!("{stream}.log");
            name == base
                || name
                    .strip_prefix(&format!("{base}."))
                    .is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
                    })
        }) else {
            continue;
        };
        let metadata = file
            .path()
            .symlink_metadata()
            .map_err(|_| "Retained log metadata could not be read.")?;
        if !metadata.is_file() {
            return Err("Unexpected retained log file type.".into());
        }
        let modified: time::OffsetDateTime = metadata
            .modified()
            .map_err(|_| "Retained log timestamp unavailable.")?
            .into();
        result.push((
            file.path(),
            Segment {
                inode: metadata.ino(),
                bytes: metadata.len(),
                stream: stream.into(),
                modified: stamp(
                    &modified
                        .format(&time::format_description::well_known::Rfc3339)
                        .map_err(|_| "Invalid log date.")?,
                )?,
            },
        ));
    }
    Ok(result)
}
fn record_id(inode: u64, offset: u64, raw: &[u8]) -> String {
    let digest = Sha256::digest(raw);
    let fingerprint = u64::from_be_bytes(digest[..8].try_into().expect("eight hash bytes"));
    format!("{inode}:{offset}:{fingerprint:016x}")
}
fn key(entry: &Entry) -> (String, String) {
    (entry.occurred_at.clone(), entry.id.clone())
}
fn keep(entries: &mut Vec<Entry>, entry: Entry, limit: usize, ascending: bool) {
    let index = entries.partition_point(|old| {
        if ascending {
            key(old) < key(&entry)
        } else {
            key(old) > key(&entry)
        }
    });
    if index < limit {
        entries.insert(index, entry);
        entries.truncate(limit);
    }
}

pub(super) fn is_stopped(status: &str) -> bool {
    status.eq_ignore_ascii_case("stopped") || status.eq_ignore_ascii_case("created")
}
pub(crate) fn query(app: &AppHandle, request: Query) -> Result<Page, String> {
    let (computer_id, computer_name) = crate::remote::log_identity()?;
    if let Some(owner) = request
        .computer_id
        .as_deref()
        .filter(|id| *id != computer_id && *id != "local")
    {
        let value = crate::remote::call_remote(
            app,
            owner,
            "runtime.logs",
            serde_json::to_value(&request).map_err(|e| e.to_string())?,
        )?;
        return serde_json::from_value(value).map_err(|_| {
            "The remote computer returned invalid logs. Update Silo on both computers.".into()
        });
    }
    let paths = runtime_paths(app)?;
    query_local(&paths, request, &computer_id, &computer_name)
}
pub(super) fn query_local(
    paths: &RuntimePaths,
    request: Query,
    computer_id: &str,
    computer_name: &str,
) -> Result<Page, String> {
    let configuration = read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    let machine = configuration
        .machines
        .iter()
        .find(|machine| machine.is_vm() && machine.id() == request.sandbox_id)
        .ok_or("This sandbox no longer exists on this computer.")?;
    validate_name(machine.name()).map_err(|e| e.to_string())?;
    let directory = paths
        .home
        .join("sandboxes")
        .join(machine.name())
        .join("logs");
    if request.cursor.is_none() {
        if let Ok(_guard) = MUTATION_LOCK.try_lock() {
            if inspect_workspace(&ProcessRunner, paths, machine.name())
                .is_ok_and(|sandbox| is_stopped(&sandbox.status))
            {
                crate::log_retention::enforce(&directory)
                    .map_err(|_| "Expired logs could not be cleaned up.")?;
            }
        }
    }
    read(
        &directory,
        request,
        machine.name(),
        computer_id,
        computer_name,
    )
}
#[tauri::command]
pub(crate) async fn query_sandbox_logs(app: AppHandle, request: Query) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || query(&app, request))
        .await
        .map_err(|e| e.to_string())?
}
fn read(
    directory: &Path,
    request: Query,
    sandbox_name: &str,
    computer_id: &str,
    computer_name: &str,
) -> Result<Page, String> {
    if request.query.as_ref().is_some_and(|q| q.len() > 4096) {
        return Err("Search text is too long.".into());
    }
    if request.source.as_deref().is_some_and(|s| {
        !matches!(
            s,
            "all" | "stdout" | "stderr" | "output" | "system" | "runtime" | "kernel"
        )
    }) {
        return Err("Unknown log source.".into());
    }
    let since = request.since.as_deref().map(stamp).transpose()?;
    let until = request.until.as_deref().map(stamp).transpose()?;
    if since
        .as_ref()
        .zip(until.as_ref())
        .is_some_and(|(s, u)| s > u)
    {
        return Err("The log time range is reversed.".into());
    }
    let binding = serde_json::to_string(&(
        &request.sandbox_id,
        computer_id,
        &request.query,
        &request.source,
        &since,
        &until,
    ))
    .map_err(|e| e.to_string())?;
    let available = files(directory)?;
    if let Some(cursor) = &request.cursor {
        return cached_page(
            directory,
            cursor,
            &binding,
            &request,
            sandbox_name,
            computer_id,
            computer_name,
        );
    }
    let snapshot = Snapshot {
        binding,
        files: available.iter().map(|(_, s)| s.clone()).collect(),
    };
    let mut locations = Vec::new();
    let mut index_bytes = 0usize;
    let mut page = Page {
        entries: Vec::new(),
        next_cursor: None,
        oldest_available_timestamp: None,
        newest_available_timestamp: None,
        total_matches: 0,
        timestamp_estimated: false,
    };
    let needle = request.query.as_deref().unwrap_or("").to_lowercase();

    let mut anchor = None;
    let mut newer = Vec::new();
    // A context request locates its original record first; the second streaming pass selects neighbours.
    for pass in 0..if request.around_id.is_some() { 2 } else { 1 } {
        for segment in &snapshot.files {
            let (path, current) = available
                .iter()
                .find(|(_, s)| {
                    s.inode == segment.inode
                        && s.stream == segment.stream
                        && s.bytes >= segment.bytes
                })
                .ok_or("Retained history changed or expired. Refresh the log search.")?;
            let file = File::open(path).map_err(|_| "Retained logs could not be opened.")?;
            if file
                .metadata()
                .map_err(|_| "Retained logs could not be read.")?
                .ino()
                != current.inode
            {
                return Err("Logs rotated during this request. Refresh the search.".into());
            }
            let mut reader = BufReader::new(file.take(segment.bytes));
            let mut offset = 0;
            loop {
                let mut bytes = Vec::new();
                let count = reader
                    .by_ref()
                    .take(1024 * 1024 + 1)
                    .read_until(b'\n', &mut bytes)
                    .map_err(|_| "Retained logs could not be read.")?;
                if count == 0 {
                    break;
                }
                if count > 1024 * 1024 {
                    return Err("A retained log record exceeds the supported 1 MiB size.".into());
                }
                let id = record_id(segment.inode, offset, &bytes);
                offset += count as u64;
                // An unfinished JSON write is not a record. Plain console chunks can
                // rotate without a newline; their captured bytes remain searchable.
                if segment.stream == "exec" && bytes.last() != Some(&b'\n') {
                    break;
                }
                let raw = String::from_utf8_lossy(&bytes);
                let (occurred_at, source, body, session) = if segment.stream == "exec" {
                    let value: Value = serde_json::from_str(&raw)
                        .map_err(|_| "Retained execution logs contain invalid data.")?;
                    (
                        stamp(value["t"].as_str().ok_or("A log timestamp is missing.")?)?,
                        value["s"].as_str().unwrap_or("system").to_string(),
                        if value["e"] == "b64" {
                            "[Binary runtime output]".into()
                        } else {
                            value["d"].as_str().unwrap_or("").to_string()
                        },
                        value["id"].as_u64().map(|id| id.to_string()),
                    )
                } else {
                    let clean = runtime_activity::strip_ansi(&raw);
                    let prefix = clean
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .trim_matches(['[', ']']);
                    let parsed = stamp(prefix).ok();
                    if parsed.is_none() {
                        page.timestamp_estimated = true;
                    }
                    (
                        parsed.unwrap_or_else(|| segment.modified.clone()),
                        segment.stream.clone(),
                        raw.trim_end().to_string(),
                        None,
                    )
                };
                if request.around_id.is_some() && pass == 0 {
                    if request.around_id.as_ref() == Some(&id) {
                        anchor = Some((occurred_at, id));
                    }
                    continue;
                }
                page.oldest_available_timestamp = Some(
                    page.oldest_available_timestamp
                        .take()
                        .map_or_else(|| occurred_at.clone(), |old| old.min(occurred_at.clone())),
                );
                page.newest_available_timestamp = Some(
                    page.newest_available_timestamp
                        .take()
                        .map_or_else(|| occurred_at.clone(), |old| old.max(occurred_at.clone())),
                );
                let line = runtime_activity::log_text(&body);
                if request.around_id.is_none()
                    && (since.as_ref().is_some_and(|s| occurred_at < *s)
                        || until.as_ref().is_some_and(|u| occurred_at > *u)
                        || !line.to_lowercase().contains(&needle)
                        || request
                            .source
                            .as_deref()
                            .is_some_and(|s| s != "all" && s != source))
                {
                    continue;
                }
                page.total_matches += 1;
                if request.around_id.is_none() {
                    index_bytes += std::mem::size_of::<Location>() + occurred_at.len() + id.len();
                    if index_bytes > 128 * 1024 * 1024 {
                        return Err("This search has too many matches. Narrow its time range or search text.".into());
                    }
                    locations.push(Location {
                        file: segment.inode,
                        offset: offset - count as u64,
                        time: occurred_at.clone(),
                        id: id.clone(),
                    });
                    continue;
                }
                let entry = Entry {
                    id,
                    line,
                    occurred_at,
                    sandbox_id: request.sandbox_id.clone(),
                    sandbox_name: sandbox_name.into(),
                    computer_id: computer_id.into(),
                    computer_name: computer_name.into(),
                    source,
                    session,
                };
                if request.around_id.is_some() {
                    let anchor = anchor
                        .as_ref()
                        .ok_or("The selected log record expired. Refresh the log search.")?;
                    if key(&entry) > *anchor {
                        keep(&mut newer, entry, 50, true);
                    } else {
                        keep(&mut page.entries, entry, 51, false);
                    }
                }
            }
        }
    }
    if request.around_id.is_some() {
        if anchor.is_none() {
            return Err("The selected log record expired. Refresh the log search.".into());
        }
        page.entries.extend(newer);
        page.entries
            .sort_by_key(|entry| std::cmp::Reverse(key(entry)));
    } else {
        locations.sort_unstable_by(|a, b| (&b.time, &b.id).cmp(&(&a.time, &a.id)));
        let id = uuid::Uuid::new_v4().to_string();
        let cached = Cached {
            binding: snapshot.binding.clone(),
            files: snapshot.files,
            records: locations,
            oldest: page.oldest_available_timestamp,
            newest: page.newest_available_timestamp,
            estimated: page.timestamp_estimated,
        };
        {
            let mut cache = cache().lock().map_err(|_| "Log query unavailable.")?;
            cache.retain(|_, (seen, _)| seen.elapsed() < Duration::from_secs(1800));
            let cost = cached
                .records
                .iter()
                .map(|r| std::mem::size_of::<Location>() + r.time.capacity() + r.id.capacity())
                .sum::<usize>();
            const INDEX_BUDGET: usize = 128 * 1024 * 1024;
            if cost > INDEX_BUDGET {
                return Err(
                    "This search has too many matches. Narrow its time range or search text."
                        .into(),
                );
            }
            while cache.len() >= 100
                || cache
                    .values()
                    .map(|(_, c)| {
                        c.records
                            .iter()
                            .map(|r| {
                                std::mem::size_of::<Location>()
                                    + r.time.capacity()
                                    + r.id.capacity()
                            })
                            .sum::<usize>()
                    })
                    .sum::<usize>()
                    + cost
                    > INDEX_BUDGET
            {
                let oldest = cache
                    .iter()
                    .min_by_key(|(_, (seen, _))| *seen)
                    .map(|(id, _)| id.clone())
                    .unwrap();
                cache.remove(&oldest);
            }
            cache.insert(id.clone(), (Instant::now(), std::sync::Arc::new(cached)));
        }
        return cached_page(
            directory,
            &format!("{id}:0"),
            &snapshot.binding,
            &request,
            sandbox_name,
            computer_id,
            computer_name,
        );
    }
    if serde_json::to_vec(&page.entries)
        .map_err(|e| e.to_string())?
        .len()
        > 1024 * 1024
    {
        return Err("This context window is too large. Narrow the time range instead.".into());
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Query {
        Query {
            sandbox_id: "vm-1".into(),
            ..Query::default()
        }
    }
    fn line(index: usize, body: &str) -> String {
        format!("{{\"t\":\"2026-09-18T12:00:00.{index:09}Z\",\"s\":\"stderr\",\"d\":\"{body}\",\"id\":42}}\n")
    }
    #[test]
    fn search_finds_old_error_across_more_than_100000_rotated_records() {
        let directory = tempfile::tempdir().unwrap();
        let mut old = File::create(directory.path().join("exec.log.12")).unwrap();
        for index in 0..100_001 {
            old.write_all(
                line(
                    index,
                    if index == 17 {
                        "historic failure"
                    } else {
                        "ordinary output"
                    },
                )
                .as_bytes(),
            )
            .unwrap();
        }
        fs::write(directory.path().join("exec.log"), line(100_002, "latest")).unwrap();
        let mut query = request();
        query.query = Some("historic failure".into());
        let page = read(directory.path(), query, "dev", "computer", "Desktop").unwrap();
        assert_eq!(page.total_matches, 1);
        assert_eq!(page.entries[0].line, "historic failure");
        assert_eq!(page.entries[0].session.as_deref(), Some("42"));
        assert_eq!(page.entries[0].computer_name, "Desktop");
        assert!(page.next_cursor.is_none());
        let started = Instant::now();
        let mut query = request();
        let mut count = 0;
        loop {
            let page = read(
                directory.path(),
                query.clone(),
                "dev",
                "computer",
                "Desktop",
            )
            .unwrap();
            count += page.entries.len();
            query.cursor = page.next_cursor;
            if query.cursor.is_none() {
                break;
            }
        }
        assert_eq!(count, 100_002);
        eprintln!("100,002-record paginated export: {:?}", started.elapsed());
    }
    #[test]
    fn pagination_survives_append_and_rename_without_gaps_or_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("exec.log"),
            (0..550).map(|i| line(i, "record")).collect::<String>(),
        )
        .unwrap();
        let first = read(directory.path(), request(), "dev", "pc", "Desktop").unwrap();
        assert_eq!(first.entries.len(), 200);
        fs::rename(
            directory.path().join("exec.log"),
            directory.path().join("exec.log.1"),
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(directory.path().join("exec.log.1"))
            .unwrap()
            .write_all(line(551, "appended").as_bytes())
            .unwrap();
        fs::write(directory.path().join("exec.log"), line(552, "new file")).unwrap();
        let mut ids: HashSet<_> = first.entries.iter().map(|e| e.id.clone()).collect();
        let mut cursor = first.next_cursor;
        while cursor.is_some() {
            let mut query = request();
            query.cursor = cursor;
            let page = read(directory.path(), query, "dev", "pc", "Desktop").unwrap();
            assert_eq!(page.total_matches, 550);
            for entry in page.entries {
                assert!(ids.insert(entry.id));
                assert_eq!(entry.line, "record");
            }
            cursor = page.next_cursor;
        }
        assert_eq!(ids.len(), 550);
    }
    #[test]
    fn context_filters_redaction_and_expired_cursor_are_explicit() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("exec.log"),
            (0..300)
                .map(|i| {
                    line(
                        i,
                        if i == 150 {
                            "old error"
                        } else {
                            "Bearer private-token"
                        },
                    )
                })
                .collect::<String>(),
        )
        .unwrap();
        let mut query = request();
        query.query = Some("old error".into());
        let found = read(directory.path(), query, "dev", "pc", "Desktop").unwrap();
        let mut query = request();
        query.around_id = Some(found.entries[0].id.clone());
        let context = read(directory.path(), query, "dev", "pc", "Desktop").unwrap();
        assert_eq!(context.entries.len(), 101);
        assert_eq!(context.entries[50].line, "old error");
        assert!(context
            .entries
            .iter()
            .all(|e| !e.line.contains("private-token")));
        let first = read(directory.path(), request(), "dev", "pc", "Desktop").unwrap();
        fs::remove_file(directory.path().join("exec.log")).unwrap();
        let mut query = request();
        query.cursor = first.next_cursor;
        assert!(read(directory.path(), query, "dev", "pc", "Desktop")
            .err()
            .unwrap()
            .contains("expired"));
    }
    #[test]
    fn replaced_content_with_same_inode_and_length_invalidates_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("exec.log");
        fs::write(
            &path,
            (0..300).map(|i| line(i, "original")).collect::<String>(),
        )
        .unwrap();
        let first = read(directory.path(), request(), "dev", "pc", "Desktop").unwrap();
        // Retention truncates the current inode; a writer can regrow it before the next page.
        fs::write(
            &path,
            (0..300).map(|i| line(i, "replaced")).collect::<String>(),
        )
        .unwrap();
        let mut query = request();
        query.cursor = first.next_cursor;
        assert!(read(directory.path(), query, "dev", "pc", "Desktop")
            .err()
            .unwrap()
            .contains("changed or expired"));
    }

    #[test]
    fn runtime_state_casing_and_non_utf8_console_output_are_supported() {
        for status in ["Stopped", "Created", "stopped", "created"] {
            assert!(is_stopped(status));
        }
        for status in ["Running", "Starting", "Failed", "unknown"] {
            assert!(!is_stopped(status));
        }
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("kernel.log"),
            b"console \xff output\n",
        )
        .unwrap();
        let page = read(directory.path(), request(), "dev", "pc", "Desktop").unwrap();
        assert_eq!(page.entries.len(), 1);
        assert!(page.entries[0].line.contains("console"));
    }
    #[test]
    fn search_and_export_preserve_text_beyond_old_display_limit() {
        let directory = tempfile::tempdir().unwrap();
        let body = format!("{} historical failure", "x".repeat(8000));
        fs::write(directory.path().join("exec.log"), line(1, &body)).unwrap();
        let mut query = request();
        query.query = Some("historical failure".into());
        let page = read(directory.path(), query, "dev", "pc", "Desktop").unwrap();
        assert_eq!(page.entries[0].line, body);
    }

    #[test]
    fn plain_text_rotation_fragments_remain_searchable_and_exportable() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("kernel.log.1"),
            b"historical kernel failure",
        )
        .unwrap();
        fs::write(
            directory.path().join("runtime.log"),
            b"current runtime failure",
        )
        .unwrap();
        fs::write(directory.path().join("exec.log"), b"{\"t\":").unwrap();
        let mut query = request();
        query.query = Some("failure".into());
        let page = read(directory.path(), query, "dev", "pc", "Desktop").unwrap();
        assert_eq!(page.entries.len(), 2);
        assert!(page
            .entries
            .iter()
            .any(|entry| entry.line == "historical kernel failure"));
        assert!(page
            .entries
            .iter()
            .any(|entry| entry.line == "current runtime failure"));
    }

    #[test]
    fn ansi_diagnostics_preserve_dates_search_and_redaction() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("runtime.log"), b"\x1b[32m2026-09-18T08:00:00Z\x1b[0m red \x1b[31mfailure\x1b[0m\nAuth\x1b[31morization: private-value\n").unwrap();
        let page = read(directory.path(), request(), "dev", "pc", "Desktop").unwrap();
        assert!(page
            .entries
            .iter()
            .any(|entry| entry.line == "[Sensitive runtime output hidden]"));
        assert!(page
            .entries
            .iter()
            .all(|entry| !entry.line.contains("[31m") && !entry.line.contains("private-value")));
        let mut query = request();
        query.query = Some("red failure".into());
        let found = read(directory.path(), query, "dev", "pc", "Desktop").unwrap();
        assert_eq!(found.entries.len(), 1);
        assert_eq!(
            found.entries[0].occurred_at,
            "2026-09-18T08:00:00.000000000Z"
        );
    }

    #[test]
    fn time_and_source_filters_cover_rotated_plain_text_with_estimated_timestamps() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("runtime.log.7"),
            "2026-09-18T08:00:00+00:00 runtime error\n",
        )
        .unwrap();
        fs::write(directory.path().join("kernel.log"), "kernel boot\n").unwrap();
        let mut query = request();
        query.source = Some("runtime".into());
        query.since = Some("2026-09-18T09:00:00+02:00".into());
        query.until = Some("2026-09-18T09:00:00Z".into());
        let page = read(directory.path(), query, "dev", "pc", "Desktop").unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].source, "runtime");
        assert!(page.timestamp_estimated);
        let mut query = request();
        query.since = Some("invalid".into());
        assert!(read(directory.path(), query, "dev", "pc", "Desktop").is_err());
    }
}
