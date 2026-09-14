//! Fixed system-owned helper; no command, source URL, or package name comes from the UI.
use std::{
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
    process::{Command, Stdio},
};
const HELPER: &str = "/usr/lib/silo/silo-system-update";

pub(super) fn preflight() -> Result<(), String> {
    if !cfg!(target_os = "linux")
        || !Path::new(HELPER).is_file()
        || !Path::new("/usr/bin/pkexec").is_file()
    {
        return Err(
            "The system updater is missing. Reinstall Silo’s Debian package to restore it.".into(),
        );
    }
    Ok(())
}
fn command(version: &str) -> Result<Command, String> {
    if version.len() > 64
        || version.split('.').count() != 3
        || version.split('.').any(|part| {
            part.is_empty()
                || !part.bytes().all(|c| c.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err("The update version is invalid. Check for updates again.".into());
    }
    let mut command = Command::new("/usr/bin/pkexec");
    command.args([
        "--disable-internal-agent",
        HELPER,
        &std::process::id().to_string(),
        version,
    ]);
    Ok(command)
}
pub(super) fn install(version: &str, status: impl FnMut(&str)) -> Result<(), String> {
    execute(&mut command(version)?, status)
}
fn execute(command: &mut Command, mut status: impl FnMut(&str)) -> Result<(), String> {
    let mut errors = tempfile::tempfile().map_err(|_| "The update log could not be opened.")?;
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(
        errors
            .try_clone()
            .map_err(|_| "The update log could not be opened.")?,
    );
    status("Waiting for administrator authentication…");
    let mut child = command.spawn().map_err(|_| "System authentication could not start. Check that a desktop authentication agent is running, then retry.")?;
    let output = child
        .stdout
        .take()
        .ok_or("System update progress is unavailable.")?;
    // The helper emits only these fixed stages. APT diagnostics remain in Details.
    for line in BufReader::new(output).lines() {
        match line.as_deref() {
            Ok("refreshing") => status("Refreshing Silo’s package list…"),
            Ok("downloading") => status("Downloading the Silo package…"),
            Ok("installing") => status("Installing Silo. It will restart when finished…"),
            _ => (),
        }
    }
    let result = child.wait().map_err(|_| "The system updater could not be monitored. Check the system package manager before retrying.")?;
    if result.success() {
        return Ok(());
    }
    if result.code() == Some(126) {
        return Err("Authentication was cancelled. Click Retry when you are ready.".into());
    }
    errors
        .seek(SeekFrom::End(0))
        .map_err(|_| "The update log could not be read.")?;
    let end = errors.stream_position().unwrap_or(0);
    errors
        .seek(SeekFrom::Start(end.saturating_sub(16384)))
        .map_err(|_| "The update log could not be read.")?;
    let mut details = String::new();
    let _ = errors.read_to_string(&mut details);
    if details.trim().is_empty() {
        details = "System authentication or package installation failed. Check that a desktop authentication agent is running, then retry.".into();
    }
    Err(details)
}
pub(super) fn failure_message(details: &str) -> &'static str {
    if details.contains("Authentication was cancelled") {
        "Update cancelled. Click Retry to authenticate."
    } else if details.contains("Software & Updates") {
        "Enable Silo’s software source in Software & Updates, then retry."
    } else if details.contains("Could not get lock") || details.contains("Unable to acquire") {
        "Another package manager is busy. Wait for it to finish, then retry."
    } else if details.contains("Failed to fetch") || details.contains("Could not resolve") {
        "The update could not be fetched. Check your connection, then retry."
    } else {
        "Silo could not finish the system update. Check Details, then retry."
    }
}
pub(super) fn restart() -> Result<(), String> {
    // Replace this process, rather than resolving /proc/self/exe after dpkg has
    // unlinked the old binary. Also ignore unrelated inherited AppImage paths.
    use std::os::unix::process::CommandExt;
    let error = Command::new("/usr/bin/silo-ui")
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .exec();
    Err(format!(
        "Silo was updated but could not restart. Quit and reopen Silo. {error}"
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_fixed_helper_and_numeric_version_can_be_executed() {
        for version in ["-y", "1.2.3;id", "1.2", "01.2.3", "1.2.3-rc1"] {
            assert!(command(version).is_err());
        }
        let cmd = command("0.5.1").unwrap();
        assert_eq!(cmd.get_program(), "/usr/bin/pkexec");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args[0], "--disable-internal-agent");
        assert_eq!(args[1], HELPER);
        assert_eq!(args[3], "0.5.1");
    }
    #[test]
    fn real_subprocess_progress_and_cancelled_authentication_are_reported() {
        let mut stages = vec![];
        let mut child = Command::new("/bin/sh");
        child.args(["-c", "printf 'refreshing\\ndownloading\\ninstalling\\n'"]);
        execute(&mut child, |stage| stages.push(stage.to_string())).unwrap();
        assert_eq!(stages.len(), 4);
        assert!(stages[1].contains("Refreshing"));
        let mut cancelled = Command::new("/bin/sh");
        cancelled.args(["-c", "exit 126"]);
        assert!(execute(&mut cancelled, |_| {})
            .unwrap_err()
            .contains("cancelled"));
        let mut failed = Command::new("/bin/sh");
        failed.args(["-c", "printf 'Package lock is busy' >&2; exit 1"]);
        assert!(execute(&mut failed, |_| {})
            .unwrap_err()
            .contains("Package lock is busy"));
    }
}
