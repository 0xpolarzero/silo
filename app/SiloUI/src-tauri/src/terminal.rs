//! Open the selected terminal on MicroSandbox's existing interactive exec path.
use crate::{applications, runtime::{self, RuntimePaths}};
use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path, process::{Command, Stdio}, time::Duration};
use tauri::AppHandle;

pub(crate) fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }
fn command(paths: &RuntimePaths, name: &str) -> Result<String, String> {
    runtime::validate_name(name).map_err(|e| e.to_string())?;
    let args = ["/usr/bin/env".to_string(), format!("MSB_HOME={}", paths.home.display()), format!("MSB_PATH={}", paths.executable.display()), format!("MSB_LIBKRUNFW_PATH={}", paths.library.display()), paths.executable.to_str().ok_or("Invalid runtime path.")?.into(), "exec".into(), name.into(), "--no-start".into(), "--workdir".into(), "/workspace".into(), "--tty".into()];
    Ok(args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" "))
}
pub(crate) fn open(app: &AppHandle, name: &str) -> Result<(), String> {
    if let Some((host, vm)) = crate::remote_access::target(name)? {
        let (alias, config) = crate::editor::prepare_remote(app, &host, &vm, "/workspace")?;
        let application = applications::selected_terminal(app)?;
        let command = ["/usr/bin/ssh", "-F", config.to_str().ok_or("Invalid SSH configuration path.")?, "-t", &alias]
            .iter().map(|arg| quote(arg)).collect::<Vec<_>>().join(" ");
        return applications::open_terminal(app, &application, &command);
    }
    runtime::validate_name(name).map_err(|e| e.to_string())?;
    let application = applications::selected_terminal(app)?;
    let paths = runtime::runtime_paths(app)?;
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    if !metadata.machines.iter().any(|m| m.name() == name && m.is_vm()) { return Err("Choose a local Silo VM.".into()); }
    let inspected = runtime::inspect_workspace(&runtime::ProcessRunner, &paths, name).map_err(|_| "Could not check this VM.")?;
    runtime::ensure_managed(&inspected).map_err(|e| e.to_string())?;
    if inspected.status != "Running" { return Err("Start this VM before opening its terminal.".into()); }
    applications::open_terminal(app, &application, &command(&paths, name)?)
}

pub(crate) fn command_file(command: &str) -> Result<std::path::PathBuf, String> {
    let mut file = tempfile::Builder::new().prefix("silo-terminal-").suffix(".command").tempfile().map_err(|_| "Could not prepare terminal command.")?;
    file.as_file().set_permissions(fs::Permissions::from_mode(0o700)).map_err(|_| "Could not protect terminal command.")?;
    writeln!(file, "#!/bin/sh\nrm -f -- \"$0\"\nexec {command}").map_err(|_| "Could not write terminal command.")?;
    file.into_temp_path().keep().map_err(|_| "Could not keep terminal command.".into())
}
pub(crate) fn launch(mut command: Command) -> Result<(), String> {
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "The selected terminal could not be opened.")?;
    // GUI launchers may stay alive for the lifetime of their window. Detect early
    // failures, then reap asynchronously without blocking the Silo action.
    std::thread::sleep(Duration::from_millis(150));
    match child.try_wait().map_err(|_| "Could not check terminal launch.")? {
        Some(status) if !status.success() => Err("The selected terminal rejected the command. Check its installation.".into()),
        Some(_) => Ok(()),
        None => { std::thread::spawn(move || { let _ = child.wait(); }); Ok(()) }
    }
}
pub(crate) fn linux_arguments(executable: &Path) -> Result<&'static [&'static str], String> {
    match executable.file_name().and_then(|n| n.to_str()) {
        Some("gnome-terminal" | "kgx") => Ok(&["--"]),
        Some("wezterm") => Ok(&["start", "--"]),
        Some("xfce4-terminal") => Ok(&["--execute"]),
        Some("ghostty" | "konsole" | "alacritty" | "kitty" | "xterm" | "tilix") => Ok(&["-e"]),
        _ => Err("This terminal does not have a supported command launcher. Choose another terminal in Settings.".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opens_in_workspace_without_starting_a_stopped_vm() {
        let paths = RuntimePaths { guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/guest-image"), executable: "/tmp/Silo app/msb".into(), home: "/tmp/runtime home".into(), storage_home: None, library: "/tmp/lib.dylib".into(), metadata: "/tmp/meta".into(), volumes: "/tmp/volumes".into() };
        let text = command(&paths, "dev").unwrap();
        assert!(text.contains("'--no-start' '--workdir' '/workspace' '--tty'"));
        assert!(text.contains("'MSB_HOME=/tmp/runtime home'"));
        assert!(command(&paths, "bad;name").is_err());
    }
    #[test]
    fn shell_arguments_stay_literal() {
        let value = "spaces ' quotes $(touch /tmp/never) `whoami`";
        let output = Command::new("/bin/sh").args(["-c", &format!("printf %s {}", quote(value))]).output().unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
    }
    #[test]
    fn private_script_executes_and_removes_itself() {
        let path = command_file("/bin/echo silo-terminal-test").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        let output = Command::new(&path).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"silo-terminal-test\n");
        assert!(!path.exists());
    }
    #[test]
    fn terminal_adapters_use_argument_boundaries_and_reject_unknown_apps() {
        assert_eq!(linux_arguments(Path::new("/bin/gnome-terminal")).unwrap(), ["--"]);
        assert_eq!(linux_arguments(Path::new("/bin/wezterm")).unwrap(), ["start", "--"]);
        assert!(linux_arguments(Path::new("/bin/unknown")).is_err());
    }
}
