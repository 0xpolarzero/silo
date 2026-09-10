//! Explicit host push: only committed objects cross the guest boundary.
use crate::runtime::{self, RuntimePaths};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::os::unix::process::CommandExt;
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

type DiscoveryCache = HashMap<String, (Instant, Result<Vec<Value>, String>)>;
static DISCOVERIES: OnceLock<Mutex<DiscoveryCache>> = OnceLock::new();
static RESULTS: OnceLock<Mutex<HashMap<String, (Value, Instant)>>> = OnceLock::new();
fn results() -> &'static Mutex<HashMap<String, (Value, Instant)>> {
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn operations() -> Vec<Value> {
    results()
        .lock()
        .map(|r| {
            r.values()
                .filter(|(value, at)| {
                    value["status"] != "succeeded" || at.elapsed() < Duration::from_secs(4)
                })
                .map(|(value, _)| value.clone())
                .collect()
        })
        .unwrap_or_default()
}
fn dismiss_result(entries: &mut HashMap<String, (Value, Instant)>, key: &str) {
    if entries
        .get(key)
        .is_some_and(|(value, _)| matches!(value["status"].as_str(), Some("failed" | "succeeded")))
    {
        entries.remove(key);
    }
}

#[tauri::command]
pub fn dismiss_repository_push(
    app: tauri::AppHandle,
    workspace: String,
    repository_path: String,
) -> Result<(), String> {
    let mut entries = results().lock().map_err(|_| "Push state unavailable.")?;
    dismiss_result(&mut entries, &format!("{workspace}\0{repository_path}"));
    drop(entries);
    let _ = app.emit("silo://application-state-changed", ());
    Ok(())
}

fn guest(paths: &RuntimePaths, name: &str, script: &str, args: &[&str]) -> Result<String, String> {
    let mut command = vec![
        "exec".into(),
        name.into(),
        "--no-tty".into(),
        "--quiet".into(),
        "--workdir".into(),
        "/".into(),
        "--timeout".into(),
        "30s".into(),
        "--".into(),
        "sh".into(),
        "-c".into(),
        script.into(),
        "silo-host-push".into(),
    ];
    command.extend(args.iter().map(|s| s.to_string()));
    runtime::run_msb(paths, &command, Duration::from_secs(45))
        .map(|o| o.stdout)
        .map_err(|_| "Could not read committed repository data from the sandbox.".into())
}
fn valid_path(path: &str) -> bool {
    path.starts_with("/workspace/")
        && !path.chars().any(char::is_control)
        && !path.split('/').any(|s| s == "..")
}
fn repository(url: &str) -> Result<String, String> {
    let name = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        .ok_or("Choose a GitHub origin repository before pushing.")?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    if name.split('/').count() != 2
        || name.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
    {
        return Err("Invalid GitHub origin repository.".into());
    }
    Ok(name.into())
}
pub(crate) fn discover(paths: &RuntimePaths, name: &str) -> Result<Vec<Value>, String> {
    let key = format!("{}:{name}", paths.home.display());
    let cache = DISCOVERIES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, result)) = cache
        .lock()
        .map_err(|_| "Repository state unavailable.")?
        .get(&key)
    {
        if at.elapsed() < Duration::from_secs(15) {
            return result.clone();
        }
    }
    let result = discover_uncached(paths, name);
    let mut cache = cache.lock().map_err(|_| "Repository state unavailable.")?;
    if cache.len() > 64 {
        cache.clear()
    }
    cache.insert(key, (Instant::now(), result.clone()));
    result
}
fn discover_uncached(paths: &RuntimePaths, name: &str) -> Result<Vec<Value>, String> {
    let output = guest(
        paths,
        name,
        r#"find /workspace -name .git -prune -print 2>/dev/null | head -201 | { count=0; while IFS= read -r directory; do
count=$((count + 1)); [ "$count" -le 200 ] || exit 1
p=${directory%/.git}
branch=$(git -C "$p" symbolic-ref --quiet --short HEAD) || continue
counts=$(git -C "$p" rev-list --left-right --count HEAD..."refs/remotes/origin/$branch" 2>/dev/null) || counts="$(git -C "$p" rev-list --count HEAD) 0"
dirty=$(git -C "$p" status --porcelain --untracked-files=no 2>/dev/null)
printf '%s\000%s\000%s\000%s\000' "$p" "$branch" "$counts" "$dirty"
done; }"#,
        &[],
    )?;
    let fields: Vec<_> = output.split('\0').collect();
    let mut rows = Vec::new();
    for parts in fields.chunks_exact(4) {
        if !valid_path(parts[0]) || parts[1].chars().any(char::is_control) {
            continue;
        }
        let counts: Vec<u64> = parts[2]
            .split_whitespace()
            .filter_map(|n| n.parse().ok())
            .collect();
        if counts.len() != 2 {
            continue;
        }
        rows.push(json!({"path":parts[0],"branch":parts[1],"ahead":counts[0],"behind":counts[1],"dirty":!parts[3].is_empty()}));
    }
    Ok(rows)
}
struct HostGit {
    executable: PathBuf,
    directory: PathBuf,
    home: PathBuf,
    support: PathBuf,
}
impl HostGit {
    fn run(&self, args: &[&str], token: Option<&str>, remote: &str) -> Result<String, String> {
        let mut command = Command::new(&self.executable);
        command.process_group(0);
        unsafe {
            command.pre_exec(|| {
                let zero = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::setrlimit(libc::RLIMIT_CORE, &zero) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "protocol.file.allow=always",
                "-c",
                "protocol.ext.allow=never",
                "-c",
                "http.followRedirects=false",
                "-c",
                "credential.helper=",
                "-c",
                "fetch.fsckObjects=true",
                "-c",
                "transfer.fsckObjects=true",
            ])
            .args(args)
            .current_dir(&self.directory)
            .env_clear()
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_EXEC_PATH", self.executable.parent().unwrap())
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin",
                    self.executable.parent().unwrap().display()
                ),
            )
            .env("GIT_TEMPLATE_DIR", self.home.join("empty-templates"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LFS_SKIP_SMUDGE", "1")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if cfg!(target_os = "linux") {
            command.env("GIT_SSL_CAINFO", self.support.join("ssl/cacert.pem"));
        }
        if let Some(token) = token {
            command
                .env("GIT_CONFIG_COUNT", "2")
                .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraHeader")
                .env(
                    "GIT_CONFIG_VALUE_0",
                    format!(
                        "Authorization: Basic {}",
                        STANDARD.encode(format!("x-access-token:{token}"))
                    ),
                )
                .env("GIT_CONFIG_KEY_1", "lfs.url")
                .env("GIT_CONFIG_VALUE_1", format!("{remote}/info/lfs"));
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Bundled Git could not start. Repair Silo and retry.")?;
        let stdout = child.stdout.take().ok_or("Cannot capture Git output.")?;
        let output_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout
                .take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        });
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            match child.try_wait().map_err(|_|"Cannot read Git process status.")? {
                Some(status) if status.success()=>break,
                Some(_)=>return Err("Git push preparation or transfer failed. Check repository access and branch protection, then retry.".into()),
                None if Instant::now()>=deadline=>{unsafe {libc::kill(-(child.id() as i32),libc::SIGKILL);}let _=child.wait();return Err("Git operation timed out. Check the remote before retrying.".into())},
                None=>thread::sleep(Duration::from_millis(25)),
            }
        }
        let output = output_reader
            .join()
            .map_err(|_| "Cannot capture Git output.")?
            .map_err(|_| "Cannot read Git output.")?;
        if output.len() > 1024 * 1024 {
            return Err("Git returned too much output to verify safely.".into());
        }
        String::from_utf8(output).map_err(|_| "Invalid Git output.".into())
    }
}
fn temporary_budget(directory: &Path) -> Result<u64, String> {
    let path = std::ffi::CString::new(directory.as_os_str().as_encoded_bytes())
        .map_err(|_| "Invalid temporary directory.")?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err("Cannot check free space for host push.".into());
    }
    let stat = unsafe { stat.assume_init() };
    let available = (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64);
    let budget = (available / 2).min(available.saturating_sub(1024 * 1024 * 1024));
    if budget == 0 {
        return Err("Free at least 1 GB of temporary disk space before pushing.".into());
    }
    Ok(budget)
}
// A binary stream into one host-created file cannot turn into a guest-directed
// recursive directory copy. The child kernel limit applies before its first write.
fn copy(
    paths: &RuntimePaths,
    name: &str,
    source: &str,
    target: &Path,
    remaining: &mut u64,
) -> Result<(), String> {
    if *remaining == 0 {
        return Err("The host push exhausted its temporary space budget.".into());
    }
    runtime::prepare_runtime_home(&paths.home, paths.storage_home.as_deref())
        .map_err(|e| e.to_string())?;
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|_| "Cannot create a private object file.")?;
    let args = vec![
        "exec".into(),
        name.into(),
        "--no-tty".into(),
        "--stream".into(),
        "--quiet".into(),
        "--workdir".into(),
        "/".into(),
        "--timeout".into(),
        "120s".into(),
        "--".into(),
        "cat".into(),
        "--".into(),
        source.into(),
    ];
    let mut command = Command::new(&paths.executable);
    command
        .args(&args)
        .env("MSB_HOME", &paths.home)
        .env("MSB_PATH", &paths.executable)
        .env("MSB_LIBKRUNFW_PATH", &paths.library)
        .env("SILO_GITHUB", runtime::github_environment(paths, &args))
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output))
        .stderr(Stdio::null());
    let limit = *remaining as libc::rlim_t;
    unsafe {
        command.pre_exec(move || {
            let zero = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::setrlimit(libc::RLIMIT_CORE, &zero) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let limits = libc::rlimit {
                rlim_cur: limit,
                rlim_max: limit,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limits) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start the bounded object transfer.")?;
    let deadline = Instant::now() + Duration::from_secs(150);
    loop {
        match child
            .try_wait()
            .map_err(|_| "Cannot read object transfer status.")?
        {
            Some(status) if status.success() => break,
            Some(_) => {
                return Err(
                    "Object transfer failed or exceeded the available temporary space budget."
                        .into(),
                )
            }
            None if Instant::now() >= deadline => {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                return Err("Object transfer timed out.".into());
            }
            None => thread::sleep(Duration::from_millis(25)),
        }
    }
    let size = fs::metadata(target)
        .map_err(|_| "Missing transferred object.")?
        .len();
    *remaining = remaining
        .checked_sub(size)
        .ok_or("Object transfer exceeded its space budget.")?;
    Ok(())
}
fn require_running(paths: &RuntimePaths, workspace: &str) -> Result<(), String> {
    let inspected = runtime::run_msb(
        paths,
        &[
            "inspect".into(),
            "--format".into(),
            "json".into(),
            workspace.into(),
        ],
        Duration::from_secs(15),
    )
    .map_err(|_| "Cannot verify sandbox state.")?;
    let inspected: runtime::InspectedSandbox =
        serde_json::from_str(&inspected.stdout).map_err(|_| "Invalid sandbox state.")?;
    validate_running(&inspected, workspace)
}
fn validate_running(inspected: &runtime::InspectedSandbox, workspace: &str) -> Result<(), String> {
    runtime::ensure_managed(inspected).map_err(|e| e.to_string())?;
    if inspected.name != workspace || !inspected.status.eq_ignore_ascii_case("running") {
        return Err("Start the sandbox before pushing its committed changes.".into());
    }
    Ok(())
}
fn perform(app: &tauri::AppHandle, workspace: &str, path: &str) -> Result<u64, String> {
    if !valid_path(path) {
        return Err("Choose a repository inside /workspace.".into());
    }
    runtime::validate_name(workspace).map_err(|e| e.to_string())?;
    let paths = runtime::runtime_paths(app)?;
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    if !metadata
        .machines
        .iter()
        .any(|m| m.is_vm() && m.name() == workspace)
    {
        return Err("Choose a managed Silo VM.".into());
    }
    let read_guard = runtime::MUTATION_LOCK
        .try_lock()
        .map_err(|_| "A sandbox operation is already running. Try again shortly.")?;
    require_running(&paths, workspace)?;
    let origin = guest(
        &paths,
        workspace,
        "git -C \"$1\" remote get-url origin",
        &[path],
    )?;
    drop(read_guard);
    let repo = repository(origin.trim())?;
    let token = crate::github::host_push_credential(app, workspace, &repo)?;
    let _guard = runtime::MUTATION_LOCK
        .try_lock()
        .map_err(|_| "A sandbox operation is already running. Try again shortly.")?;
    require_running(&paths, workspace)?;
    let executable = std::env::current_exe()
        .map_err(|_| "Cannot locate bundled Git.")?
        .with_file_name("git");
    let support = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate Git support.")?
        .join("git-support");
    push_committed(&paths, workspace, path, &repo, &token, &executable, &support)
}

// The same object-transfer path is exercised with disposable VMs and scoped
// credentials in the opt-in live regression. Authorization stays in perform.
pub(crate) fn push_committed(
    paths: &RuntimePaths,
    workspace: &str,
    path: &str,
    repo: &str,
    token: &str,
    executable: &Path,
    support: &Path,
) -> Result<u64, String> {
    let export = format!("/tmp/silo-push-{}", uuid::Uuid::new_v4());
    let result = (|| {
        let data = guest(
            &paths,
            workspace,
            r#"set -eu
mkdir -m 700 "$2"
git -C "$1" bundle create "$2/commits.bundle" HEAD >/dev/null
git -C "$1" symbolic-ref --quiet --short HEAD
git -C "$1" rev-parse --git-common-dir"#,
            &[path, &export],
        )?;
        let mut lines = data.lines();
        let branch = lines.next().ok_or("Missing Git branch.")?;
        let common = lines.next().ok_or("Missing Git object directory.")?;
        let common = if common.starts_with('/') {
            common.into()
        } else {
            format!("{path}/{common}")
        };
        let temp = tempfile::tempdir().map_err(|_| "Cannot create isolated host Git directory.")?;
        let root = temp.path();
        let mut remaining = temporary_budget(root)?;
        let bundle = root.join("commits.bundle");
        copy(
            &paths,
            workspace,
            &format!("{export}/commits.bundle"),
            &bundle,
            &mut remaining,
        )?;
        let git = HostGit {
            executable: executable.to_path_buf(),
            directory: root.join("repository.git"),
            home: root.join("home"),
            support: support.to_path_buf(),
        };
        fs::create_dir_all(&git.directory)
            .and_then(|_| fs::create_dir_all(git.home.join("empty-templates")))
            .map_err(|_| "Cannot create isolated host Git directory.")?;
        git.run(&["check-ref-format", "--branch", branch], None, "")?;
        git.run(&["init", "--bare", "--quiet"], None, "")?;
        git.run(
            &[
                "fetch",
                "--keep",
                "--no-tags",
                bundle.to_str().ok_or("Invalid bundle path.")?,
                "HEAD:refs/silo/push",
            ],
            None,
            "",
        )?;
        git.run(&["fsck", "--strict", "--no-reflogs"], None, "")?;
        let remote = format!("https://github.com/{repo}.git");
        git.run(&["remote", "add", "origin", &remote], None, "")?;
        let lfs = git.run(
            &["lfs", "push", "--dry-run", "origin", "refs/silo/push"],
            Some(&token),
            &remote,
        )?;
        for line in lfs.lines() {
            let oid = line
                .strip_prefix("push ")
                .and_then(|value| value.split_whitespace().next())
                .ok_or("Invalid LFS transfer plan.")?;
            if oid.len() != 64 || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid LFS object identifier.".into());
            }
            let relative = format!("lfs/objects/{}/{}/{oid}", &oid[..2], &oid[2..4]);
            let target = git.directory.join(&relative);
            fs::create_dir_all(target.parent().unwrap()).map_err(|_| "Cannot store LFS object.")?;
            copy(
                &paths,
                workspace,
                &format!("{common}/{relative}"),
                &target,
                &mut remaining,
            )?;
            let mut file = fs::File::open(&target).map_err(|_| "Cannot read LFS object.")?;
            let mut hash = Sha256::new();
            let mut buffer = [0; 65536];
            loop {
                let n = file
                    .read(&mut buffer)
                    .map_err(|_| "Cannot verify LFS object.")?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            if format!("{:x}", hash.finalize()) != oid {
                return Err("The sandbox returned an LFS object with the wrong hash.".into());
            }
        }
        git.run(
            &["lfs", "push", "origin", "refs/silo/push"],
            Some(&token),
            &remote,
        )?;
        let remote_head = git.run(
            &[
                "ls-remote",
                "--heads",
                "origin",
                &format!("refs/heads/{branch}"),
            ],
            Some(&token),
            &remote,
        )?;
        let range = if remote_head.trim().is_empty() {
            "refs/silo/push".to_string()
        } else {
            git.run(
                &[
                    "fetch",
                    "--keep",
                    "--no-tags",
                    "origin",
                    &format!("refs/heads/{branch}:refs/silo/remote"),
                ],
                Some(&token),
                &remote,
            )?;
            "refs/silo/remote..refs/silo/push".to_string()
        };
        let count = git
            .run(&["rev-list", "--count", &range], None, "")?
            .trim()
            .parse()
            .map_err(|_| "Invalid commit count.")?;
        git.run(
            &[
                "push",
                "--porcelain",
                "origin",
                &format!("refs/silo/push:refs/heads/{branch}"),
            ],
            Some(&token),
            &remote,
        )?;
        let pushed = git.run(&["rev-parse", "refs/silo/push"], None, "")?;
        // Only local tracking metadata changes; the guest never receives credentials.
        let _ = guest(
            &paths,
            workspace,
            "git -C \"$1\" update-ref \"$2\" \"$3\"",
            &[
                path,
                &format!("refs/remotes/origin/{branch}"),
                pushed.trim(),
            ],
        );
        if let Some(cache) = DISCOVERIES.get() {
            if let Ok(mut cache) = cache.lock() {
                cache.remove(&format!("{}:{workspace}", paths.home.display()));
            }
        }
        Ok(count)
    })();
    let _ = guest(&paths, workspace, "rm -rf -- \"$1\"", &[&export]);
    result
}
#[tauri::command]
pub async fn push_repository(
    app: tauri::AppHandle,
    workspace: String,
    repository_path: String,
) -> Result<Value, String> {
    let key = format!("{workspace}\0{repository_path}");
    let planned_count = runtime::runtime_paths(&app)
        .ok()
        .and_then(|paths| {
            DISCOVERIES
                .get()?
                .lock()
                .ok()?
                .get(&format!("{}:{workspace}", paths.home.display()))?
                .1
                .as_ref()
                .ok()?
                .iter()
                .find(|repo| repo["path"] == repository_path)?["ahead"]
                .as_u64()
        })
        .unwrap_or(0);
    {
        let mut r = results().lock().map_err(|_| "Push state unavailable.")?;
        if r.get(&key).is_some_and(|(v, _)| v["status"] == "pushing") {
            return Err("This repository is already being pushed.".into());
        }
        r.insert(key.clone(),(json!({"workspace":workspace,"repositoryPath":repository_path,"commitCount":planned_count,"status":"pushing"}),Instant::now()));
    }
    let _ = app.emit("silo://application-state-changed", ());
    tauri::async_runtime::spawn_blocking(move||{
        let outcome=perform(&app,&workspace,&repository_path);
        let value=match outcome {Ok(count)=>json!({"workspace":workspace,"repositoryPath":repository_path,"commitCount":count,"status":"succeeded"}),Err(message)=>json!({"workspace":workspace,"repositoryPath":repository_path,"commitCount":0,"status":"failed","message":message})};
        results().lock().map_err(|_|"Push state unavailable.")?.insert(key,(value.clone(),Instant::now()));let _=app.emit("silo://application-state-changed",());Ok(value)
    }).await.map_err(|_|"Host push task failed.")?
}
#[cfg(test)]
pub(crate) fn verify_disposable_binary_transfer(
    paths: &RuntimePaths,
    name: &str,
) -> Result<(), String> {
    guest(
        paths,
        name,
        "printf '\\000\\377\\001\\376' > /tmp/silo-test-binary",
        &[],
    )?;
    let temporary =
        tempfile::tempdir().map_err(|_| "Cannot prepare binary transfer verification.")?;
    let target = temporary.path().join("binary");
    let mut remaining = 64 * 1024 * 1024;
    copy(
        paths,
        name,
        "/tmp/silo-test-binary",
        &target,
        &mut remaining,
    )?;
    if fs::read(&target).map_err(|_| "Cannot read binary transfer verification.")?
        != [0, 255, 1, 254]
        || remaining != 64 * 1024 * 1024 - 4
    {
        return Err("VM binary transfer changed bytes or did not account for their size.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn dismissal_removes_finished_results_but_preserves_active_pushes() {
        let mut entries = std::collections::HashMap::new();
        for status in ["failed", "succeeded", "pushing"] {
            entries.insert(
                status.into(),
                (
                    serde_json::json!({"status":status}),
                    std::time::Instant::now(),
                ),
            );
        }
        for status in ["failed", "succeeded", "pushing"] {
            super::dismiss_result(&mut entries, status);
        }
        assert_eq!(entries.len(), 1);
        assert!(entries.contains_key("pushing"));
        super::dismiss_result(&mut entries, "failed");
        assert_eq!(entries.len(), 1);
    }

    use super::*;
    #[test]
    fn rejects_untrusted_remote_destinations() {
        for url in [
            "https://github.com.evil/a/b",
            "https://user@github.com/a/b",
            "https://github.com/a/b?token=x",
            "https://github.com/a/../b",
            "ssh://evil/a/b",
            "https://github.com/a/b/c",
        ] {
            assert!(repository(url).is_err(), "{url}")
        }
        assert_eq!(
            repository("git@github.com:owner/repo.git").unwrap(),
            "owner/repo"
        );
    }
    #[test]
    fn accepts_native_running_status_and_rejects_stopped_or_unmanaged_sandboxes() {
        let mut inspected: runtime::InspectedSandbox = serde_json::from_value(
            json!({"name":"dev","status":"Running","config":{"labels":{"silo.managed":"true"}}}),
        )
        .unwrap();
        assert!(validate_running(&inspected, "dev").is_ok());
        inspected.status = "Stopped".into();
        assert!(validate_running(&inspected, "dev").is_err());
        inspected.status = "Running".into();
        inspected.config = json!({});
        assert!(validate_running(&inspected, "dev").is_err());
    }
    #[test]
    fn binary_transfer_preserves_bytes_and_kernel_limit_stops_oversized_guest_output() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let executable = root.join("msb");
        fs::write(
            &executable,
            "#!/bin/sh\n[ \"$4\" = \"--stream\" ] || exit 42\nprintf '\\000\\377'\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let paths = RuntimePaths {
            guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/guest-image"),
            executable: executable.clone(),
            home: root.join("runtime"),
            storage_home: None,
            library: root.join("unused-library"),
            metadata: root.join("metadata"),
            volumes: root.join("volumes"),
        };
        let mut budget = 1024;
        let target = root.join("bytes");
        copy(&paths, "dev", "/guest/object", &target, &mut budget).unwrap();
        assert_eq!(fs::read(target).unwrap(), vec![0, 255]);
        assert_eq!(budget, 1022);
        fs::write(
            &executable,
            "#!/bin/sh\nexec /bin/dd if=/dev/zero bs=512 count=4\n",
        )
        .unwrap();
        let target = root.join("oversized");
        assert!(copy(&paths, "dev", "/guest/object", &target, &mut budget).is_err());
        assert!(fs::metadata(target).unwrap().len() <= 1022);
    }
    #[test]
    fn host_git_rejects_oversized_output_without_spooling_to_disk() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("git");
        fs::write(
            &executable,
            "#!/bin/sh\nexec /bin/dd if=/dev/zero bs=65536 count=32\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let git = HostGit {
            executable,
            directory: directory.path().into(),
            home: directory.path().into(),
            support: directory.path().into(),
        };
        assert!(git.run(&[], None, "").is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[test]
    fn requires_workspace_repository_paths() {
        assert!(valid_path("/workspace/repo"));
        for path in ["/etc", "/workspace/../etc", "/workspace/repo\nother"] {
            assert!(!valid_path(path));
        }
    }
    #[test]
    fn bundle_import_uses_commits_without_guest_worktree_or_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/git/bin/git");
        assert!(
            executable.is_file(),
            "prepare the bundled Git runtime before testing"
        );
        let make = |name: &str| {
            let directory = root.join(name);
            let home = root.join(format!("{name}-home"));
            fs::create_dir_all(&directory).unwrap();
            fs::create_dir_all(home.join("empty-templates")).unwrap();
            HostGit {
                executable: executable.clone(),
                directory,
                home,
                support: root.into(),
            }
        };
        let source = make("guest");
        source.run(&["init", "--quiet"], None, "").unwrap();
        fs::write(source.directory.join("README"), "committed\n").unwrap();
        source.run(&["add", "README"], None, "").unwrap();
        source
            .run(
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-m",
                    "test",
                    "--quiet",
                ],
                None,
                "",
            )
            .unwrap();
        fs::write(source.directory.join("README"), "dirty secret\n").unwrap();
        fs::write(source.directory.join("untracked"), "untracked secret\n").unwrap();
        source
            .run(
                &[
                    "config",
                    "credential.helper",
                    "!echo guest-credential-helper",
                ],
                None,
                "",
            )
            .unwrap();
        let bundle = root.join("commits.bundle");
        source
            .run(
                &["bundle", "create", bundle.to_str().unwrap(), "HEAD"],
                None,
                "",
            )
            .unwrap();
        let host = make("host.git");
        host.run(&["init", "--bare", "--quiet"], None, "").unwrap();
        host.run(
            &[
                "fetch",
                "--keep",
                "--no-tags",
                bundle.to_str().unwrap(),
                "HEAD:refs/silo/push",
            ],
            None,
            "",
        )
        .unwrap();
        host.run(&["fsck", "--strict", "--no-reflogs"], None, "")
            .unwrap();
        assert_eq!(
            host.run(&["show", "refs/silo/push:README"], None, "")
                .unwrap(),
            "committed\n"
        );
        assert!(!host
            .run(&["ls-tree", "--name-only", "refs/silo/push"], None, "")
            .unwrap()
            .contains("untracked"));
        assert!(!fs::read_to_string(host.directory.join("config"))
            .unwrap()
            .contains("guest-credential-helper"));
    }
}
