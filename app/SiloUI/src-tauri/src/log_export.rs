//! Stream retained log pages to an atomic, user-selected JSON Lines export.
use crate::runtime::runtime_logs::{self, Page, Query};
use serde::Serialize;
use std::{
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

static EXPORT_LOCK: Mutex<()> = Mutex::new(());
static CANCELLED: AtomicBool = AtomicBool::new(false);

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Open the main Silo window to export logs.".into())
    }
}

fn write_json_line(output: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer(&mut *output, value).map_err(|_| "Could not write the log export.")?;
    output
        .write_all(b"\n")
        .map_err(|_| "Could not write the log export.".into())
}

// The selected destination is replaced only after every page succeeds. A dropped
// temporary removes partial output on cancellation, disconnect or disk failure.
fn save_atomically(
    destination: &Path,
    write: impl FnOnce(&mut std::fs::File) -> Result<bool, String>,
) -> Result<bool, String> {
    let parent = destination
        .parent()
        .ok_or("The export destination is unavailable.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Could not create the log export at this destination.")?;
    if !write(temporary.as_file_mut())? {
        return Ok(false);
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Could not finish the log export.")?;
    temporary
        .persist(destination)
        .map_err(|_| "Could not save the completed log export.")?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn cancel_log_export(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    CANCELLED.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub(crate) async fn export_workspace_logs(
    app: AppHandle,
    window: WebviewWindow,
    requests: Vec<Query>,
) -> Result<bool, String> {
    require_main(&window)?;
    if requests.is_empty() || requests.len() > 100 {
        return Err("Select between one and 100 sandboxes to export logs.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = EXPORT_LOCK
            .try_lock()
            .map_err(|_| "A log export is already in progress.")?;
        CANCELLED.store(false, Ordering::Release);
        let Some(selected) = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Export logs")
            .set_file_name("silo-logs.jsonl")
            .add_filter("JSON Lines", &["jsonl"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let destination = selected
            .into_path()
            .map_err(|_| "The export destination is unavailable.")?;
        save_atomically(&destination, |output| {
            write_requests(
                output,
                requests,
                |request| runtime_logs::query(&app, request),
                || CANCELLED.load(Ordering::Acquire),
            )
        })
    })
    .await
    .map_err(|_| "The log export task failed.".to_owned())?
}

fn write_requests(
    output: &mut impl Write,
    requests: Vec<Query>,
    mut query: impl FnMut(Query) -> Result<Page, String>,
    cancelled: impl Fn() -> bool,
) -> Result<bool, String> {
    write_json_line(
        output,
        &serde_json::json!({
            "type": "silo-log-export", "version": 1,
            "note": "Each sandbox is a separate snapshot. Timestamps and identities are retained; sensitive output is filtered as in Silo."
        }),
    )?;
    for mut request in requests {
        // Export all matches, including pages the user has not loaded.
        request.cursor = None;
        let mut cursors = std::collections::HashSet::new();
        loop {
            if cancelled() {
                return Ok(false);
            }
            let page = query(request.clone())?;
            if cancelled() {
                return Ok(false);
            }
            if request.cursor.is_none() {
                write_json_line(
                    output,
                    &serde_json::json!({
                        "type": "coverage", "request": request,
                        "oldestAvailableTimestamp": page.oldest_available_timestamp,
                        "newestAvailableTimestamp": page.newest_available_timestamp,
                        "totalMatches": page.total_matches,
                        "timestampEstimated": page.timestamp_estimated,
                    }),
                )?;
            }
            if page.next_cursor.is_some() && page.entries.is_empty() {
                return Err("The log export returned an incomplete page. Retry the export.".into());
            }
            for entry in &page.entries {
                write_json_line(output, entry)?;
            }
            match page.next_cursor {
                Some(cursor) if cursors.insert(cursor.clone()) => request.cursor = Some(cursor),
                Some(_) => return Err("The log export stopped advancing. Retry the export.".into()),
                None => break,
            }
        }
    }
    Ok(!cancelled())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(offset: usize, total: usize) -> Page {
        let end = (offset + 200).min(total);
        Page {
            entries: (offset..end)
                .map(|index| runtime_logs::Entry {
                    id: index.to_string(),
                    line: format!("échec\nrecord {index}"),
                    occurred_at: "2026-09-18T10:00:00Z".into(),
                    sandbox_id: "vm-id".into(),
                    sandbox_name: "dev".into(),
                    computer_id: "host-id".into(),
                    computer_name: "Build computer".into(),
                    source: "stderr".into(),
                    session: Some("42".into()),
                })
                .collect(),
            next_cursor: (end < total).then(|| end.to_string()),
            oldest_available_timestamp: Some("2026-09-18T10:00:00Z".into()),
            newest_available_timestamp: Some("2026-09-18T10:00:00Z".into()),
            total_matches: total,
            timestamp_estimated: false,
        }
    }

    #[test]
    fn export_reads_every_matching_page_and_preserves_identity() {
        let mut output = Vec::new();
        let mut calls = 0;
        let query = Query {
            sandbox_id: "vm-id".into(),
            cursor: Some("400".into()),
            ..Query::default()
        };
        assert!(write_requests(
            &mut output,
            vec![query],
            |request| {
                calls += 1;
                Ok(page(
                    request.cursor.as_deref().unwrap_or("0").parse().unwrap(),
                    1001,
                ))
            },
            || false
        )
        .unwrap());
        assert_eq!(calls, 6);
        let text = String::from_utf8(output).unwrap();
        let records: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records.len(), 1003); // Header, coverage, then all records.
        assert_eq!(records[2]["id"], "0");
        assert_eq!(records.last().unwrap()["id"], "1000");
        assert_eq!(records.last().unwrap()["computerName"], "Build computer");
        assert_eq!(records.last().unwrap()["session"], "42");
        assert_eq!(records.last().unwrap()["line"], "échec\nrecord 1000");
    }

    #[test]
    fn cancellation_stops_after_pending_page_without_publishing_it() {
        let cancelled = std::cell::Cell::new(false);
        let mut output = Vec::new();
        let mut calls = 0;
        let result = write_requests(
            &mut output,
            vec![Query::default()],
            |_| {
                calls += 1;
                cancelled.set(true);
                Ok(page(0, 1001))
            },
            || cancelled.get(),
        )
        .unwrap();
        assert!(!result);
        assert_eq!(calls, 1);
        assert_eq!(String::from_utf8(output).unwrap().lines().count(), 1);
    }

    #[test]
    fn repeated_remote_cursor_fails_instead_of_looping_forever() {
        let mut output = Vec::new();
        let result = write_requests(
            &mut output,
            vec![Query::default()],
            |_| Ok(page(0, 1001)),
            || false,
        );
        assert!(result.unwrap_err().contains("stopped advancing"));
    }

    #[test]
    fn failed_or_cancelled_export_preserves_existing_destination_and_removes_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("logs.jsonl");
        std::fs::write(&destination, b"previous export").unwrap();
        let failed = save_atomically(&destination, |output| {
            output.write_all(b"partial page").unwrap();
            Err("Remote computer disconnected.".into())
        });
        assert!(failed.is_err());
        assert!(!save_atomically(&destination, |output| {
            output.write_all(b"cancelled page").unwrap();
            Ok(false)
        })
        .unwrap());
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous export");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn completed_export_preserves_record_boundaries_and_unicode() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("logs.jsonl");
        assert!(save_atomically(&destination, |output| {
            for index in 0..1001 {
                write_json_line(output, &serde_json::json!({"id": index, "line": "échec\nsecond line", "sandboxId": "vm-id", "computerId": "host-id", "occurredAt": "2026-09-18T10:00:00Z"}))?;
            }
            Ok(true)
        }).unwrap());
        let text = std::fs::read_to_string(destination).unwrap();
        assert_eq!(text.lines().count(), 1001);
        let last: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(last["id"], 1000);
        assert_eq!(last["line"], "échec\nsecond line");
        assert_eq!(last["computerId"], "host-id");
    }
}
