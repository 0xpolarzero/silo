//! Parent-lifetime ownership for SSH forwards and their process groups.
use std::{
    os::unix::process::CommandExt,
    process::{Child, ChildStdin, Command, Stdio},
    time::{Duration, Instant},
};

/// Runs the forward in its own process group and ends the whole group (ssh
/// and its ProxyCommand) when Silo's end of stdin closes: on Drop, and also
/// when Silo crashes or is force-quit, since the kernel closes it then.
/// `kill 0` is safe only because the group is the tunnel's own.
const WATCHDOG: &str = r#"exec 3<&0 </dev/null
"$@" 3<&- &
child=$!
{ read -r _ <&3; kill -s TERM 0; } &
exec 3<&-
wait "$child"
kill -s TERM 0
"#;

/// The ssh forward and the private directory holding its Unix socket.
pub(crate) struct Tunnel {
    /// The watchdog shell, leader of the tunnel's process group.
    child: Child,
    /// Silo's end of the watchdog pipe; closing it ends the tunnel.
    stdin: Option<ChildStdin>,
    /// Set once the leader is reaped: its group id may then be reused.
    exited: bool,
    /// Removed after the child is reaped (fields drop after `drop`).
    _directory: Option<tempfile::TempDir>,
}
impl Tunnel {
    pub(crate) fn spawn(
        command: &Command,
        directory: Option<tempfile::TempDir>,
    ) -> std::io::Result<Self> {
        let mut child = crate::applications::launch::sanitize_child(&mut Command::new("/bin/sh"))
            .arg("-c")
            .arg(WATCHDOG)
            .arg("silo-tunnel")
            .arg(command.get_program())
            .args(command.get_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()?;
        let stdin = child.stdin.take();
        Ok(Self {
            child,
            stdin,
            exited: false,
            _directory: directory,
        })
    }
    #[cfg(test)]
    pub(crate) fn close_lifetime_pipe(&mut self) {
        drop(self.stdin.take());
    }

    pub(crate) fn running(&mut self) -> bool {
        if !self.exited && !matches!(self.child.try_wait(), Ok(None)) {
            self.exited = true;
        }
        !self.exited
    }
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if !self.running() {
            return;
        }
        // The unreaped leader keeps the group id reserved, so this reaches only
        // the tunnel's own processes. ssh and the shell exit on TERM at once.
        let group = self.child.id() as i32;
        unsafe { libc::killpg(group, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if !self.running() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        unsafe { libc::killpg(group, libc::SIGKILL) };
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
