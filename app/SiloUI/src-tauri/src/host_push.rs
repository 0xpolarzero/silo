//! Explicit host push: only committed objects cross the guest boundary.
use crate::runtime::{self, RuntimePaths};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
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
pub async fn dismiss_repository_push(
    app: tauri::AppHandle,
    workspace: String,
    repository_path: String,
) -> Result<(), String> {
    if let Some((host, vm)) = crate::remote_access::target(&workspace)? {
        return tauri::async_runtime::spawn_blocking(move || {
            crate::remote::call_remote(
                &app,
                &host,
                "repository.dismiss",
                json!({"vmId":vm,"path":repository_path}),
            )
            .map(|_| ())
        })
        .await
        .map_err(|_| "Remote repository request failed.".to_string())?;
    }
    crate::host_push_operations::dismiss(&app, &workspace, &repository_path)?;
    let mut entries = results().lock().map_err(|_| "Push state unavailable.")?;
    dismiss_result(&mut entries, &format!("{workspace}\0{repository_path}"));
    drop(entries);
    let _ = app.emit("silo://application-state-changed", ());
    Ok(())
}

fn guest(paths: &RuntimePaths, name: &str, script: &str, args: &[&str]) -> Result<String, String> {
    let user = crate::working_account::inspect_user(paths, name)?;
    let mut command = vec![
        "exec".into(),
        name.into(),
        "--user".into(), user.into(),
        "--env".into(), format!("USER={user}"),
        "--env".into(), format!("LOGNAME={user}"),
        "--no-start".into(),
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
pub(crate) fn discover(paths: &RuntimePaths, name: &str, refresh: bool) -> Result<Vec<Value>, String> {
    let key = format!("{}:{name}", paths.home.display());
    let cache = DISCOVERIES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, result)) = cache
        .lock()
        .map_err(|_| "Repository state unavailable.")?
        .get(&key)
    {
        if !refresh && at.elapsed() < Duration::from_secs(15) {
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
// The guest deadline and runtime output budget bound discovery. An entry-count
// cutoff discards every result when a workspace contains many Git worktrees.
const DISCOVER_REPOSITORIES: &str = r#"find "$1" -name .git -prune -print 2>/dev/null | while IFS= read -r directory; do
p=${directory%/.git}
branch=$(git -C "$p" symbolic-ref --quiet --short HEAD) || continue
counts=$(git -C "$p" rev-list --left-right --count HEAD..."refs/remotes/origin/$branch" 2>/dev/null) || counts="$(git -C "$p" rev-list --count HEAD) 0"
dirty=$(git -C "$p" status --porcelain --untracked-files=no 2>/dev/null)
printf '%s\000%s\000%s\000%s\000' "$p" "$branch" "$counts" "$dirty"
done"#;

fn discover_uncached(paths: &RuntimePaths, name: &str) -> Result<Vec<Value>, String> {
    let output = guest(paths, name, DISCOVER_REPOSITORIES, &["/workspace"])?;
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
    ssh_command: Option<String>,
    cache_lock_fd: Option<std::os::fd::RawFd>,
}
impl HostGit {
    fn run(&self, args: &[&str], token: Option<&str>, remote: &str) -> Result<String, String> {
        let mut command = Command::new(&self.executable);
        command.process_group(0);
        let file_budget = temporary_budget(&self.directory)? as libc::rlim_t;
        let cache_lock_fd = self.cache_lock_fd;
        unsafe {
            command.pre_exec(move || {
                // Keep the cache locked until this Git process exits, even if
                // Silo crashes. The parent owns the file for the entire command.
                if let Some(fd) = cache_lock_fd {
                    if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                let zero = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::setrlimit(libc::RLIMIT_CORE, &zero) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let limit = libc::rlimit {
                    rlim_cur: file_budget,
                    rlim_max: file_budget,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
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
                "-c",
                "gc.auto=0",
                "-c",
                "maintenance.auto=false",
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
            .stderr(Stdio::piped());
        if let Some(ssh_command) = &self.ssh_command {
            command
                .env("GIT_SSH_COMMAND", ssh_command)
                .env("GIT_SSH_VARIANT", "ssh");
        }
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
        let stderr = child
            .stderr
            .take()
            .ok_or("Cannot capture Git diagnostics.")?;
        let output_reader = thread::spawn(move || read_bounded(stdout, 1024 * 1024));
        let diagnostic_reader = thread::spawn(move || read_bounded(stderr, 16_384));
        let deadline = Instant::now() + Duration::from_secs(1800);
        let mut space_check = Instant::now();
        let outcome = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(_) => break Err("Cannot read Git process status."),
                Ok(None) if Instant::now() >= deadline => {
                    break Err("Git operation timed out. Check the remote before retrying.");
                }
                Ok(None) => {
                    if space_check.elapsed() >= Duration::from_secs(1) {
                        if temporary_budget(&self.directory).is_err() {
                            break Err("Host push stopped to preserve free disk space.");
                        }
                        space_check = Instant::now();
                    }
                    thread::sleep(Duration::from_millis(25));
                }
            }
        };
        // The process group belongs only to this invocation. Close inherited
        // pipes on failure so a helper cannot leave the readers blocked.
        if outcome.as_ref().map_or(true, |status| !status.success()) {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
        }
        let (output, overflow) = output_reader
            .join()
            .map_err(|_| "Cannot capture Git output.")??;
        let (diagnostic, _) = diagnostic_reader
            .join()
            .map_err(|_| "Cannot capture Git diagnostics.")??;
        let mut diagnostic = String::from_utf8_lossy(&diagnostic).into_owned();
        if let Some(token) = token {
            diagnostic = diagnostic.replace(token, "[redacted]").replace(
                &STANDARD.encode(format!("x-access-token:{token}")),
                "[redacted]",
            );
        }
        let diagnostic = transfer_diagnostic(diagnostic.as_bytes());
        let mut command_args = args;
        while command_args.first() == Some(&"-c") && command_args.len() >= 2 {
            command_args = &command_args[2..];
        }
        let stage = command_args
            .iter()
            .take(if command_args.first() == Some(&"lfs") {
                2
            } else {
                1
            })
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        match outcome {
            Ok(status) if !status.success() => {
                return Err(format!("Git {stage} failed ({status}). {diagnostic}"))
            }
            Err(message) => return Err(format!("{message} {diagnostic}")),
            _ => {}
        }
        if overflow {
            return Err("Git returned too much output to verify safely.".into());
        }
        String::from_utf8(output).map_err(|_| "Invalid Git output.".into())
    }
}
fn read_bounded(mut input: impl Read, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut retained = Vec::new();
    let mut overflow = false;
    let mut buffer = [0; 8192];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| "Cannot read Git output.")?;
        if count == 0 {
            break;
        }
        let keep = count.min(limit - retained.len());
        retained.extend_from_slice(&buffer[..keep]);
        overflow |= keep < count;
    }
    Ok((retained, overflow))
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
// Drain stderr while retaining a bounded diagnostic so a noisy runtime cannot
// block the binary stream or consume unbounded memory.
fn transfer_diagnostic(mut input: impl Read) -> String {
    let mut retained = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(count) = input.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let keep = count.min(16_384 - retained.len());
        retained.extend_from_slice(&buffer[..keep]);
    }
    String::from_utf8_lossy(&retained)
        .split_whitespace()
        .map(|word| {
            if word.contains('/')
                || word.contains('@')
                || word.contains('=')
                || word.to_ascii_lowercase().contains("token")
                || word.len() > 80
            {
                "[redacted]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(2000)
        .collect()
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
    let _update = crate::updates::operation_guard()?;
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
    runtime::shutdown::ensure_accepting_operations()?;
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
    runtime::shutdown::ensure_accepting_operations()?;
    require_running(&paths, workspace)?;
    let executable = crate::bundled_tools::directory(app)?.join("git");
    let support = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate Git support.")?
        .join("git-support");
    push_committed(
        &paths,
        workspace,
        path,
        &repo,
        &token,
        &executable,
        &support,
    )
}

// The host owns all configuration and credentials. The source remote supplies
// Git/LFS data through their standard protocols, never hooks or configuration.
fn publish_committed(
    git: &HostGit,
    source: &str,
    source_lfs: &str,
    source_ref: &str,
    expected_commit: &str,
    branch: &str,
    remote: &str,
    token: Option<&str>,
) -> Result<u64, String> {
    git.run(&["check-ref-format", "--branch", branch], None, "")?;
    git.run(&["init", "--bare", "--quiet"], None, "")?;
    // This host-owned cache contains only Silo's configuration. Repoint both
    // remotes for every invocation; no guest configuration crosses this seam.
    git.run(
        &["config", "--replace-all", "remote.origin.url", remote],
        None,
        "",
    )?;
    git.run(
        &["config", "--replace-all", "remote.silo-source.url", source],
        None,
        "",
    )?;
    git.run(
        &[
            "fetch",
            "--no-tags",
            "silo-source",
            &format!("+{source_ref}:refs/silo/push"),
        ],
        None,
        "",
    )?;
    let imported = git.run(&["rev-parse", "refs/silo/push"], None, "")?;
    if imported.trim() != expected_commit {
        return Err("The sandbox repository changed during export. Retry the push.".into());
    }
    // fetch.fsckObjects verifies incoming objects without rescanning the
    // complete trusted cache on every incremental push.
    // Only the currently advertised destination ref may exclude LFS uploads.
    // A previous cached branch must not suppress objects for a new destination.
    git.run(
        &["update-ref", "-d", "refs/remotes/origin/published"],
        None,
        "",
    )?;
    let target_ref = format!("refs/heads/{branch}");
    let remote_head = git.run(
        &["ls-remote", "--heads", "origin", &target_ref],
        token,
        remote,
    )?;
    let range = if remote_head.trim().is_empty() {
        "refs/silo/push"
    } else {
        git.run(
            &[
                "fetch",
                "--no-tags",
                "origin",
                &format!("+{target_ref}:refs/remotes/origin/published"),
            ],
            token,
            remote,
        )?;
        // Ask Git before spending time transferring LFS data. The final push
        // still performs Git's own concurrent-update/non-fast-forward checks.
        git.run(&["merge-base", "--is-ancestor", "refs/remotes/origin/published", "refs/silo/push"], None, "")
            .map_err(|_| "The remote branch has commits missing from this sandbox. Fetch and integrate them before pushing.".to_string())?;
        "refs/remotes/origin/published..refs/silo/push"
    };
    let count = git
        .run(&["rev-list", "--count", range], None, "")?
        .trim()
        .parse()
        .map_err(|_| "Invalid commit count.")?;

    // --all includes LFS data referenced only by historical commits. An object
    // absent from the sandbox may already exist upstream. LFS itself decides
    // whether such an object is needed; a source fetch alone is not the gate.
    let source_result = git.run(
        &[
            "-c",
            &format!("lfs.url={source_lfs}"),
            "-c",
            "lfs.sshtransfer=always",
            "-c",
            "lfs.ssh.variant=ssh",
            "lfs",
            "fetch",
            "--all",
            "silo-source",
            "refs/silo/push",
        ],
        None,
        "",
    );
    if let Err(first_push) = git.run(&["lfs", "push", "origin", "refs/silo/push"], token, remote) {
        // Standard LFS fetch fills pruned historical data from the destination.
        // Content-addressed LFS uploads can safely be retried before any Git ref
        // update. Never enable allowincompletepush or parse a human transfer plan.
        let upstream_result = git.run(
            &["lfs", "fetch", "--all", "origin", "refs/silo/push"],
            token,
            remote,
        );
        git.run(&["lfs", "push", "origin", "refs/silo/push"], token, remote)
            .map_err(|error| {
                format!(
                    "{error} Source transfer: {} Upstream recovery: {} First upload: {first_push}",
                    source_result.err().unwrap_or_else(|| "completed".into()),
                    upstream_result.err().unwrap_or_else(|| "completed".into())
                )
            })?;
    }
    git.run(
        &[
            "push",
            "--porcelain",
            "origin",
            &format!("refs/silo/push:{target_ref}"),
        ],
        token,
        remote,
    )?;
    Ok(count)
}

// The same publication path is exercised with disposable VMs and scoped
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
    let id = uuid::Uuid::new_v4();
    let export = format!("/tmp/silo-push-{id}");
    let export_ref = format!("refs/silo/export/{id}");
    let result = (|| {
        let temp = tempfile::tempdir().map_err(|_| "Cannot create isolated host Git directory.")?;
        let root = temp.path();
        let cache_key = format!("{workspace}\0{path}\0{repo}");
        let cache = crate::host_push_cache::acquire(&paths.home.join("push-cache"), &cache_key)?;
        let mut transport =
            crate::host_push_transport::prepare(paths, workspace, &root.join("ssh"))?;
        transport.install_lfs_server(&support.join("lfs-transfer/git-lfs-transfer"), &export)?;
        let data = guest(
            paths,
            workspace,
            r#"set -eu
branch=$(git -C "$1" symbolic-ref --quiet --short HEAD)
commit=$(git -C "$1" rev-parse --verify "refs/heads/$branch^{commit}")
git -C "$1" update-ref "$3" "$commit"
# Use Git LFS's own storage resolution, including linked worktrees and lfs.storage.
media=$(git -C "$1" lfs env | sed -n 's/^LocalMediaDir=//p')
case "$media" in /*) ;; *) echo 'Git LFS returned no absolute media directory' >&2; exit 1;; esac
mkdir -p "$2/source.git/lfs"
if [ -d "$media" ]; then
    ln -s -- "$media" "$2/source.git/lfs/objects"
else
    mkdir "$2/source.git/lfs/objects"
fi
printf '%s\n%s\n' "$branch" "$commit"
"#,
            &[path, &export, &export_ref],
        )?;
        let mut lines = data.lines();
        let branch = lines.next().ok_or("Missing Git branch.")?;
        let commit = lines.next().ok_or("Missing Git commit.")?;
        if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid exported Git commit.".into());
        }
        let git = HostGit {
            executable: executable.to_path_buf(),
            directory: cache.directory.join("repository.git"),
            home: root.join("home"),
            support: support.to_path_buf(),
            ssh_command: Some(transport.ssh_command.clone()),
            cache_lock_fd: Some(cache.lock_fd()),
        };
        fs::create_dir_all(&git.directory)
            .and_then(|_| fs::create_dir_all(git.home.join("empty-templates")))
            .map_err(|_| "Cannot create isolated host Git directory.")?;
        let source = transport.repository_url(path)?;
        let source_lfs = format!("ssh://{}{export}/source.git", transport.alias);
        let publication = publish_committed(
            &git,
            &source,
            &source_lfs,
            &export_ref,
            commit,
            branch,
            &format!("https://github.com/{repo}.git"),
            Some(token),
        );
        if publication.is_err() {
            cache.discard();
        }
        let count = publication?;
        // Tracking metadata describes the commit actually published, even if
        // the sandbox branch advanced while this operation was running.
        let _ = guest(
            paths,
            workspace,
            "git -C \"$1\" update-ref \"$2\" \"$3\"",
            &[path, &format!("refs/remotes/origin/{branch}"), commit],
        );
        if let Some(cache) = DISCOVERIES.get() {
            if let Ok(mut cache) = cache.lock() {
                cache.remove(&format!("{}:{workspace}", paths.home.display()));
            }
        }
        Ok(count)
    })();
    let _ = guest(
        paths,
        workspace,
        "git -C \"$1\" update-ref -d \"$3\"; rm -rf -- \"$2\"",
        &[path, &export, &export_ref],
    );
    result
}
#[tauri::command]
pub async fn push_repository(
    app: tauri::AppHandle,
    workspace: String,
    repository_path: String,
) -> Result<Value, String> {
    if let Some((host, vm)) = crate::remote_access::target(&workspace)? {
        return tauri::async_runtime::spawn_blocking(move || {
            crate::remote::call_remote(
                &app,
                &host,
                "repository.push",
                json!({"vmId":vm,"path":repository_path}),
            )
        })
        .await
        .map_err(|_| "Remote repository request failed.".to_string())?;
    }
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
    fn manual_discovery_bypasses_cached_rows() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("missing-msb");
        let paths = RuntimePaths {
            executable,
            home: root.path().to_path_buf(),
            guest_image: root.path().join("image"),
            storage_home: None,
            library: root.path().join("library"),
            metadata: root.path().join("metadata"),
            volumes: root.path().join("volumes"),
        };
        let key = format!("{}:test", paths.home.display());
        let cached = vec![json!({"path": "removed-repository"})];
        DISCOVERIES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap()
            .insert(key.clone(), (Instant::now(), Ok(cached.clone())));
        assert_eq!(discover(&paths, "test", false).unwrap(), cached);
        // A forced read must reach the missing runtime instead of returning
        // the fresh cached rows. No real VM or runtime is involved.
        let refreshed = discover(&paths, "test", true);
        assert!(refreshed.is_err());
        assert_eq!(discover(&paths, "test", false), refreshed);
        DISCOVERIES.get().unwrap().lock().unwrap().remove(&key);
    }

    #[test]
    fn discovery_keeps_repositories_beyond_two_hundred_entries() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let seed = root.path().join("seed");
        fs::create_dir(&seed).unwrap();
        for args in [
            vec!["init", "--quiet", "--initial-branch=main"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        ] {
            assert!(Command::new("git")
                .args(args)
                .current_dir(&seed)
                .status()
                .unwrap()
                .success());
        }
        let workspace = root.path().join("workspace with spaces");
        fs::create_dir(&workspace).unwrap();
        for index in 0..216 {
            let repo = workspace.join(format!("repo-{index}"));
            fs::create_dir(&repo).unwrap();
            symlink(seed.join(".git"), repo.join(".git")).unwrap();
        }
        let output = Command::new("sh")
            .args(["-c", DISCOVER_REPOSITORIES, "silo-host-push"])
            .arg(&workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "scan exited with {}",
            output.status
        );
        let output = String::from_utf8(output.stdout).unwrap();
        let records: Vec<_> = output.split('\0').collect();
        assert_eq!(records.len(), 216 * 4 + 1);
        for record in records.chunks_exact(4) {
            assert_eq!(record[1], "main");
            assert_eq!(record[2], "1 0");
            assert_eq!(record[3], "");
        }
    }

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
    fn transfer_diagnostics_are_bounded_and_drain_noisy_output() {
        let bytes = vec![b'x'; 100_000];
        let mut input = std::io::Cursor::new(bytes);
        let detail = transfer_diagnostic(&mut input);
        assert_eq!(input.position(), 100_000);
        assert_eq!(detail, "[redacted]");
        assert_eq!(
            transfer_diagnostic(&b"error token=secret /private/path user@host"[..]),
            "error [redacted] [redacted] [redacted]"
        );
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
            ssh_command: None,
            cache_lock_fd: None,
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
}

#[cfg(test)]
#[path = "host_push_protocol_tests.rs"]
mod protocol_tests;
