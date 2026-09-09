//! Read-only, bounded directory snapshots. Pagination never combines two scans.
use crate::runtime::{ensure_managed, inspect_workspace, run_msb, runtime_paths, ProcessRunner};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;

const PAGE_SIZE: usize = 200;
const MAX_ENTRIES: usize = 20_000;
const MAX_SNAPSHOTS: usize = 64;
const FAILED: &str = "Could not load this folder.";
const EXPIRED: &str = "Folder listing expired. Refresh this folder.";
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    name: String,
    path: String,
    kind: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryPage {
    entries: Vec<Entry>,
    next_offset: Option<usize>,
    snapshot_id: String,
}
static NEXT_SNAPSHOT: AtomicU64 = AtomicU64::new(1);
struct Snapshot {
    id: String,
    created: Instant,
    entries: Vec<Entry>,
}
static SNAPSHOTS: OnceLock<Mutex<HashMap<(String, String), Snapshot>>> = OnceLock::new();

fn valid_path(path: &str) -> bool {
    path.len() <= 4096
        && !path.contains('\0')
        && (path == "/workspace"
            || path.strip_prefix("/workspace/").is_some_and(|tail| {
                tail.split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
            }))
}
fn parse_listing(output: &str, path: &str) -> Result<Vec<Entry>, String> {
    let mut parts = output.split('\0');
    match parts.next() {
        Some("ok") => (),
        Some("missing") => return Err("This folder no longer exists.".into()),
        Some("denied") => return Err("Permission denied.".into()),
        Some("invalid") => return Err("This folder cannot be browsed.".into()),
        _ => return Err(FAILED.into()),
    }
    let mut entries = Vec::new();
    let mut bytes = 0;
    loop {
        let kind = match parts.next() {
            Some("") if parts.next().is_none() => break,
            Some(kind) => kind,
            None => return Err(FAILED.into()),
        };
        let name = parts.next().ok_or(FAILED)?;
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains('/')
            || entries.len() == MAX_ENTRIES
        {
            return Err("This folder is too large to list.".into());
        }
        bytes += name.len() * 2 + path.len() + 96;
        if bytes > 2 * 1024 * 1024 {
            return Err("This folder is too large to list.".into());
        }
        let kind = match kind {
            "d" => "folder",
            "l" => "symlink",
            "f" | "b" | "c" | "p" | "s" => "file",
            _ => return Err(FAILED.into()),
        };
        entries.push(Entry {
            name: name.into(),
            path: format!("{path}/{name}"),
            kind: kind.into(),
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "folder")
            .cmp(&(b.kind != "folder"))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}
fn page(entries: &[Entry], offset: usize, snapshot_id: &str) -> Result<DirectoryPage, String> {
    if offset > entries.len() {
        return Err(EXPIRED.into());
    }
    let end = (offset + PAGE_SIZE).min(entries.len());
    Ok(DirectoryPage {
        entries: entries[offset..end].to_vec(),
        next_offset: (end < entries.len()).then_some(end),
        snapshot_id: snapshot_id.into(),
    })
}
#[tauri::command]
pub(crate) async fn list_workspace_directory(
    app: AppHandle,
    workspace: String,
    path: String,
    offset: usize,
    snapshot_id: Option<String>,
) -> Result<DirectoryPage, String> {
    if !valid_path(&path) || offset > MAX_ENTRIES || offset % PAGE_SIZE != 0 {
        return Err("Invalid folder request.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime_paths(&app).map_err(|_| FAILED.to_owned())?;
        let state =
            inspect_workspace(&ProcessRunner, &paths, &workspace).map_err(|_| FAILED.to_owned())?;
        ensure_managed(&state).map_err(|_| FAILED.to_owned())?;
        if state.status != "Running" {
            return Err("Start this VM to browse its files.".into());
        }
        let key = (workspace.clone(), path.clone());
        let snapshots = SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()));
        if offset != 0 {
            let cache = snapshots.lock().map_err(|_| FAILED.to_owned())?;
            let snapshot = cache
                .get(&key)
                .filter(|s| {
                    s.created.elapsed() < Duration::from_secs(120)
                        && snapshot_id.as_deref() == Some(s.id.as_str())
                })
                .ok_or(EXPIRED)?;
            return page(&snapshot.entries, offset, &snapshot.id);
        }
        let output = run_msb(
            &paths,
            &[
                "exec".into(),
                workspace,
                "--no-start".into(),
                "--no-tty".into(),
                "--quiet".into(),
                "--timeout".into(),
                "5s".into(),
                "--workdir".into(),
                "/".into(),
                "--".into(),
                "bash".into(),
                "-c".into(),
                include_str!("../guest/list-directory.sh").into(),
                "silo-files".into(),
                path.clone(),
            ],
            Duration::from_secs(8),
        )
        .map_err(|_| FAILED.to_owned())?;
        let entries = parse_listing(&output.stdout, &path)?;
        let id = NEXT_SNAPSHOT.fetch_add(1, Ordering::Relaxed).to_string();
        let result = page(&entries, 0, &id)?;
        let mut cache = snapshots.lock().map_err(|_| FAILED.to_owned())?;
        cache.retain(|_, s| s.created.elapsed() < Duration::from_secs(120));
        while cache.len() >= MAX_SNAPSHOTS
            || cache
                .values()
                .map(|s| {
                    s.entries
                        .iter()
                        .map(|e| e.name.len() + e.path.len() + 96)
                        .sum::<usize>()
                })
                .sum::<usize>()
                > 6 * 1024 * 1024
        {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, s)| s.created)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            key,
            Snapshot {
                id,
                created: Instant::now(),
                entries,
            },
        );
        Ok(result)
    })
    .await
    .map_err(|_| FAILED.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_reject_escape_and_noncanonical_names() {
        for path in [
            "/",
            "/workspace2",
            "/workspace/../etc",
            "/workspace//x",
            "/workspace/x/",
            "/workspace/./x",
            "/workspace/\0",
        ] {
            assert!(!valid_path(path));
        }
        assert!(valid_path("/workspace/new\nfolder/日本語"));
    }
    #[test]
    fn listing_preserves_names_and_does_not_treat_links_as_folders() {
        let entries = parse_listing("ok\0f\0a\nb\0l\0link\0d\0日本語\0", "/workspace").unwrap();
        assert_eq!(entries[0].kind, "folder");
        assert_eq!(entries[1].name, "a\nb");
        assert_eq!(entries[2].kind, "symlink");
    }
    #[test]
    fn listing_failures_never_become_empty_success() {
        for listing in [
            "",
            "ok",
            "ok\0f\0bad",
            "ok\0d\0../x\0",
            "denied\0",
            "missing\0",
        ] {
            assert!(parse_listing(listing, "/workspace").is_err());
        }
        assert!(parse_listing("ok\0", "/workspace").unwrap().is_empty());
    }
    #[test]
    fn long_paths_cannot_expand_snapshot_memory_without_bound() {
        let output = format!("ok\0{}", "f\0short\0".repeat(1000));
        let path = format!("/workspace/{}", "x".repeat(4000));
        assert_eq!(
            parse_listing(&output, &path).unwrap_err(),
            "This folder is too large to list."
        );
    }
    #[test]
    fn pagination_is_bounded_and_complete() {
        let entries: Vec<_> = (0..401)
            .map(|i| Entry {
                name: i.to_string(),
                path: i.to_string(),
                kind: "file".into(),
            })
            .collect();
        assert_eq!(page(&entries, 0, "test").unwrap().next_offset, Some(200));
        assert_eq!(page(&entries, 200, "test").unwrap().entries.len(), 200);
        assert_eq!(page(&entries, 400, "test").unwrap().entries.len(), 1);
        assert_eq!(page(&entries, 400, "test").unwrap().next_offset, None);
    }
}
