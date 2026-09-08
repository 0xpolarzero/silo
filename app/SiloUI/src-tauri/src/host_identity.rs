//! Read configured author defaults without opening a repository or changing host settings.
use serde::Serialize;
use std::{
    ffi::OsString,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HostIdentity {
    pub name: String,
    pub email: String,
}

pub fn read() -> Option<HostIdentity> {
    let home = std::env::var_os("HOME")?;
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    directories.extend([
        PathBuf::from(&home).join(".local/bin"),
        PathBuf::from(&home).join(".cargo/bin"),
    ]);
    directories
        .extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    let environment: Vec<(OsString, OsString)> = [
        "HOME",
        "XDG_CONFIG_HOME",
        "GIT_CONFIG_GLOBAL",
        "JJ_CONFIG",
        "JJ_USER",
        "JJ_EMAIL",
    ]
    .iter()
    .filter_map(|key| std::env::var_os(key).map(|value| ((*key).into(), value)))
    .collect();
    read_with(|tool, key| {
        let executable = directories.iter().map(|dir| dir.join(tool)).find(|path| {
            use std::os::unix::fs::PermissionsExt;
            path.metadata().is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })?;
        let args = if tool == "git" {
            vec!["config", "--global", "--includes", "--get", key]
        } else {
            vec!["--ignore-working-copy", "--no-pager", "config", "get", key]
        };
        query(&executable, &args, &environment, Duration::from_secs(2))
    })
}

fn read_with(mut get: impl FnMut(&str, &str) -> Option<String>) -> Option<HostIdentity> {
    for tool in ["git", "jj"] {
        let name = get(tool, "user.name").and_then(valid_value);
        let email = get(tool, "user.email").and_then(valid_value);
        if let (Some(name), Some(email)) = (name, email) {
            return Some(HostIdentity { name, email });
        }
    }
    None
}

fn valid_value(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

fn query(
    executable: &Path,
    args: &[&str],
    environment: &[(OsString, OsString)],
    timeout: Duration,
) -> Option<String> {
    // Root cannot inherit the app checkout's Git/Jujutsu repository configuration.
    let mut output = tempfile::tempfile().ok()?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir("/")
        .env_clear()
        .envs(environment.iter().cloned())
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone().ok()?))
        .stderr(Stdio::null());
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None)
                if Instant::now() < deadline
                    && output
                        .metadata()
                        .is_ok_and(|metadata| metadata.len() <= 4096) =>
            {
                thread::sleep(Duration::from_millis(10))
            }
            _ => {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                return None;
            }
        }
    }
    output.seek(SeekFrom::Start(0)).ok()?;
    let mut bytes = Vec::new();
    output.take(4097).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_complete_git_and_never_combines_tools() {
        let identity = read_with(|tool, key| {
            assert_eq!(tool, "git");
            Some(
                if key == "user.name" {
                    "Git Author\n"
                } else {
                    "git@example.com\n"
                }
                .into(),
            )
        })
        .unwrap();
        assert_eq!(identity.name, "Git Author");
        let fallback = read_with(|tool, key| match (tool, key) {
            ("git", "user.name") => Some("Git Author".into()),
            ("jj", "user.name") => Some("JJ Author".into()),
            ("jj", "user.email") => Some("jj@example.com".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(fallback.name, "JJ Author");
        assert_eq!(fallback.email, "jj@example.com");
    }

    #[test]
    fn absent_empty_and_malformed_values_never_become_identity() {
        assert!(read_with(|_, _| None).is_none());
        for value in ["", " \n", "name\nsecond", "name\u{1b}[31m"] {
            assert!(read_with(|_, _| Some(value.into())).is_none());
        }
        assert!(read_with(|_, _| Some("x".repeat(1025))).is_none());
    }

    #[test]
    fn subprocess_failure_timeout_and_excess_output_are_unavailable() {
        assert!(query(
            Path::new("/bin/sh"),
            &["-c", "exit 1"],
            &[],
            Duration::from_secs(1)
        )
        .is_none());
        assert!(query(
            Path::new("/bin/sh"),
            &["-c", "sleep 2"],
            &[],
            Duration::from_millis(30)
        )
        .is_none());
        assert!(query(
            Path::new("/bin/sh"),
            &["-c", "while :; do printf 'too much output'; done"],
            &[],
            Duration::from_secs(1)
        )
        .is_none());
    }

    #[test]
    fn git_reads_included_global_identity_without_repository_or_host_settings() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("included"),
            "[user]\n name = Included Author\n email = included@example.com\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join(".gitconfig"),
            "[include]\n path = included\n",
        )
        .unwrap();
        let environment = vec![("HOME".into(), root.path().as_os_str().to_owned())];
        let name = query(
            Path::new("/usr/bin/git"),
            &["config", "--global", "--includes", "--get", "user.name"],
            &environment,
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(name.trim(), "Included Author");
    }
}
