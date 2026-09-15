//! Bounded, private publishing repositories. A root lock serializes cache use
//! and eviction across application processes; credentials never belong here.
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    fs::{self, File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::SystemTime,
};

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const FAILED: &str = "Could not prepare the private publishing cache.";

pub(crate) struct Cache {
    pub(crate) directory: PathBuf,
    root: PathBuf,
    budget: u64,
    discarded: Cell<bool>,
    _lock: File,
}

pub(crate) fn acquire(root: &Path, key: &str) -> Result<Cache, String> {
    acquire_with_budget(root, key, MAX_BYTES)
}

fn private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(FAILED.into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| FAILED)?;
        }
        Err(_) => return Err(FAILED.into()),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| FAILED.into())
}

fn acquire_with_budget(root: &Path, key: &str, budget: u64) -> Result<Cache, String> {
    private_directory(root)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join(".lock"))
        .map_err(|_| FAILED)?;
    if !lock.metadata().map_err(|_| FAILED)?.is_file() {
        return Err(FAILED.into());
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(
            "Another host push is using the publishing cache. Wait for it to finish.".into(),
        );
    }
    let directory = root.join(format!("{:x}", Sha256::digest(key.as_bytes())));
    private_directory(&directory)?;
    // Obtaining the root lock proves no previous Git child is still using this
    // cache. A surviving marker means its process died before normal cleanup.
    if fs::symlink_metadata(directory.join(".active")).is_ok() {
        fs::remove_dir_all(&directory).map_err(|_| FAILED)?;
        private_directory(&directory)?;
    }
    sweep(root, budget)?;
    private_directory(&directory)?;
    tree_size(&directory)?;
    let mut marker = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join(".last-used"))
        .map_err(|_| FAILED)?;
    use std::io::Write;
    marker.write_all(b"used\n").map_err(|_| FAILED)?;
    let mut active = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join(".active"))
        .map_err(|_| FAILED)?;
    active
        .write_all(b"active\n")
        .and_then(|_| active.sync_all())
        .map_err(|_| FAILED)?;
    File::open(&directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| FAILED)?;
    Ok(Cache {
        directory,
        root: root.into(),
        budget,
        discarded: Cell::new(false),
        _lock: lock,
    })
}

impl Cache {
    /// Invalidate failed publication state while retaining the operation lock.
    /// Preserve the active marker if deletion fails so acquisition retries it.
    pub(crate) fn discard(&self) {
        self.discarded.set(true);
        let _ = fs::remove_dir_all(&self.directory);
    }

    pub(crate) fn lock_fd(&self) -> std::os::fd::RawFd {
        self._lock.as_raw_fd()
    }
}

impl Drop for Cache {
    fn drop(&mut self) {
        // Publication has already completed. Cache cleanup must not relabel a
        // successful remote ref update as a failed push. Retry on next acquire.
        if !self.discarded.get() {
            let _ = fs::remove_file(self.directory.join(".active"));
        }
        let _ = sweep(&self.root, self.budget);
        // Explicitly release before close: an unrelated concurrent fork can
        // briefly inherit this open-file description until its exec closes it.
        unsafe {
            libc::flock(self._lock.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn tree_size(path: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if metadata.file_type().is_symlink() {
        return Err(
            "The publishing cache contains a symbolic link. Remove this cache before retrying."
                .into(),
        );
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Err(FAILED.into());
    }
    let mut bytes = 0_u64;
    for entry in fs::read_dir(path).map_err(|_| FAILED)? {
        bytes = bytes.saturating_add(tree_size(&entry.map_err(|_| FAILED)?.path())?);
    }
    Ok(bytes)
}

fn sweep(root: &Path, budget: u64) -> Result<(), String> {
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for entry in fs::read_dir(root).map_err(|_| FAILED)? {
        let entry = entry.map_err(|_| FAILED)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(FAILED.into());
        };
        if name == ".lock" {
            continue;
        }
        if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(FAILED.into());
        }
        let path = entry.path();
        let bytes = tree_size(&path)?;
        if bytes > budget {
            fs::remove_dir_all(&path).map_err(|_| FAILED)?;
            continue;
        }
        let modified = fs::symlink_metadata(path.join(".last-used"))
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        total = total.saturating_add(bytes);
        entries.push((modified, path, bytes));
    }
    entries.sort_by_key(|(modified, _, _)| *modified);
    for (_, path, bytes) in entries {
        if total <= budget {
            break;
        }
        fs::remove_dir_all(path).map_err(|_| FAILED)?;
        total = total.saturating_sub(bytes);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_lock_survives_parent_exit_until_git_child_finishes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("cache");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "host_push_cache::tests::inherited_lock_child",
                "--ignored",
            ])
            .env("SILO_CACHE_LOCK_TEST_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(acquire(&root, "second")
            .err()
            .unwrap()
            .contains("Another host push"));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if acquire(&root, "second").is_ok() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child did not release cache lock"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    #[ignore = "helper executed by inherited_lock_survives_parent_exit_until_git_child_finishes"]
    fn inherited_lock_child() {
        use std::os::unix::process::CommandExt;
        let root = std::env::var_os("SILO_CACHE_LOCK_TEST_ROOT").expect("helper requires root");
        let cache = acquire(Path::new(&root), "first").unwrap();
        let fd = cache.lock_fd();
        let mut child = std::process::Command::new("/bin/sleep");
        child
            .arg("1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        unsafe {
            child.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        child.spawn().unwrap();
        // Match a crash: process exit skips Cache::drop and its explicit unlock.
        std::process::exit(0);
    }

    #[test]
    fn reuses_same_repository_and_excludes_concurrent_process_handles() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("cache");
        let cache = acquire(&root, "computer/sandbox/repository").unwrap();
        fs::write(cache.directory.join("retained-object"), b"payload").unwrap();
        assert!(acquire(&root, "another-repository")
            .err()
            .unwrap()
            .contains("Another host push"));
        let directory = cache.directory.clone();
        drop(cache);
        let second = acquire(&root, "computer/sandbox/repository").unwrap();
        assert_eq!(second.directory, directory);
        assert_eq!(
            fs::read(second.directory.join("retained-object")).unwrap(),
            b"payload"
        );
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    #[test]
    fn evicts_oldest_repository_and_removes_single_oversized_repository() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("cache");
        let first = acquire_with_budget(&root, "first", 100).unwrap();
        let first_path = first.directory.clone();
        fs::write(first.directory.join("objects"), [0; 60]).unwrap();
        drop(first);
        let second = acquire_with_budget(&root, "second", 100).unwrap();
        let second_path = second.directory.clone();
        fs::write(second.directory.join("objects"), [0; 60]).unwrap();
        drop(second);
        assert!(!first_path.exists());
        assert!(second_path.exists());
        let huge = acquire_with_budget(&root, "huge", 100).unwrap();
        let huge_path = huge.directory.clone();
        fs::write(huge.directory.join("objects"), [0; 101]).unwrap();
        drop(huge);
        assert!(!huge_path.exists());
        assert!(second_path.exists());
    }
    #[test]
    fn crash_markers_and_failed_publications_discard_stale_git_locks() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("cache");
        let cache = acquire(&root, "key").unwrap();
        let directory = cache.directory.clone();
        fs::write(directory.join("retained-object"), b"payload").unwrap();
        drop(cache);
        assert!(!directory.join(".active").exists());
        fs::write(directory.join(".active"), b"crashed").unwrap();
        fs::write(directory.join("config.lock"), b"incomplete configuration").unwrap();
        let recovered = acquire(&root, "key").unwrap();
        assert!(!recovered.directory.join("config.lock").exists());
        assert!(!recovered.directory.join("retained-object").exists());
        assert!(recovered.directory.join(".active").is_file());
        fs::write(directory.join("config.lock"), b"failed operation").unwrap();
        recovered.discard();
        assert!(!directory.exists());
        assert!(
            acquire(&root, "another").is_err(),
            "discard must retain the lock"
        );
        drop(recovered);
        let clean = acquire(&root, "key").unwrap();
        assert!(!clean.directory.join("config.lock").exists());
    }

    #[test]
    fn never_follows_symbolic_links_in_cache_or_lock() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("cache");
        let target = temporary.path().join("outside");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &root).unwrap();
        assert!(acquire(&root, "key").is_err());
        fs::remove_file(&root).unwrap();
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(&target, root.join(".lock")).unwrap();
        assert!(acquire(&root, "key").is_err());
        fs::remove_file(root.join(".lock")).unwrap();
        let cache = acquire(&root, "key").unwrap();
        std::os::unix::fs::symlink(&target, cache.directory.join("objects")).unwrap();
        drop(cache);
        assert!(acquire(&root, "key").is_err());
        assert!(target.is_dir());
    }
}
