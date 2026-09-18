//! Shared with the pinned runtime patch. Only call from Silo for stopped VMs.
//! Live runtime writers serialize retention and writes with their process lock.
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const MAX_BYTES: u64 = 250 * 1024 * 1024;
pub const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const SEGMENT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub fn marker(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.started", path.display()))
}
pub fn mark(path: &Path, now: SystemTime) -> io::Result<()> {
    if fs::symlink_metadata(marker(path)).is_ok_and(|m| !m.is_file()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "log age marker is not a regular file",
        ));
    }
    fs::write(
        marker(path),
        now.duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string(),
    )
}
pub fn started(path: &Path) -> io::Result<SystemTime> {
    if fs::symlink_metadata(marker(path)).is_ok_and(|m| m.is_file()) {
        if let Ok(value) = fs::read_to_string(marker(path)) {
            if let Ok(seconds) = value.parse::<u64>() {
                if let Some(time) = UNIX_EPOCH.checked_add(Duration::from_secs(seconds)) {
                    return Ok(time);
                }
            }
        }
    }
    let metadata = fs::metadata(path)?;
    // Legacy files have no segment marker. Creation is conservative where available.
    Ok(metadata
        .created()
        .unwrap_or(metadata.modified()?)
        .min(metadata.modified()?))
}
pub fn is_log(name: &str) -> bool {
    ["exec.log", "runtime.log", "kernel.log"]
        .iter()
        .any(|base| {
            name == *base
                || name
                    .strip_prefix(&format!("{base}."))
                    .is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_digit())
                    })
        })
}
pub fn enforce(dir: &Path) -> io::Result<()> {
    enforce_at(dir, SystemTime::now(), MAX_BYTES, MAX_AGE)
}
pub fn enforce_at(
    dir: &Path,
    now: SystemTime,
    max_bytes: u64,
    max_age: Duration,
) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !is_log(&entry.file_name().to_string_lossy()) || !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let age = started(&path)?;
        files.push((age, path, entry.metadata()?.len()));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    for (start, path, size) in files {
        if now.duration_since(start).unwrap_or_default() < max_age && total <= max_bytes {
            continue;
        }
        if path.extension().is_some_and(|ext| ext == "log") {
            // Preserve the inode held by an idle writer; it detects length zero next write.
            fs::OpenOptions::new().write(true).open(&path)?.set_len(0)?;
            mark(&path, now)?;
        } else {
            fs::remove_file(&path)?;
            match fs::remove_file(marker(&path)) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        total = total.saturating_sub(size);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "silo-retention-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn expires_oldest_segment_even_if_recently_modified() {
        let dir = dir();
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let old = dir.join("exec.log.1");
        fs::write(&old, "old and recent records").unwrap();
        mark(&old, now - MAX_AGE).unwrap();
        let fresh = dir.join("kernel.log");
        fs::write(&fresh, "new").unwrap();
        mark(&fresh, now).unwrap();
        enforce_at(&dir, now, MAX_BYTES, MAX_AGE).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(fresh).unwrap(), "new");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn budget_is_shared_and_current_inode_survives_expiry() {
        let dir = dir();
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        for (name, seconds) in [("exec.log.1", 3), ("runtime.log.1", 2), ("kernel.log", 1)] {
            let path = dir.join(name);
            fs::write(&path, "12345").unwrap();
            mark(&path, now - Duration::from_secs(seconds)).unwrap();
        }
        fs::write(dir.join("unrelated"), "keep").unwrap();
        enforce_at(&dir, now, 10, MAX_AGE).unwrap();
        assert!(!dir.join("exec.log.1").exists());
        assert!(dir.join("runtime.log.1").exists());
        enforce_at(&dir, now + MAX_AGE, 10, MAX_AGE).unwrap();
        assert_eq!(fs::metadata(dir.join("kernel.log")).unwrap().len(), 0);
        assert!(dir.join("unrelated").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn only_known_streams_and_numeric_archives_are_logs() {
        assert!(is_log("exec.log.42"));
        assert!(!is_log("exec.log.started"));
        assert!(!is_log("secret.log"));
        assert!(!is_log("kernel.log."));
    }
}
