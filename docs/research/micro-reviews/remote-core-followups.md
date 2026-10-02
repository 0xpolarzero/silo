# Remote core fix-loop follow-up

Scope: `app/SiloUI/src-tauri/src/remote.rs`.

## REMOTE-CORE-3: Valid replies exceed the transport spool limit

- **Severity:** P2.
- **File:line:** `app/SiloUI/src-tauri/src/remote.rs:978` at parent commit `e87d3c62`; `write_reply` and `read_reply` define the framing and shell-output allowance.
- **Trigger:** A valid JSON reply near the 4 MiB frame limit follows a permitted SSH shell banner, while the SSH child remains alive long enough for the spool-size check.
- **Consequence:** The transport kills the child and reports an unknown-outcome timeout despite receiving a valid bounded reply. The former limit counted only the frame body and four-byte header; it omitted the reply preamble and the 64 KiB permitted shell output.
- **Suggested fix:** Include the preamble and permitted shell output in the transport bound; preserve the existing frame and shell-output parser limits.
- **Test:** `exchange_accepts_a_near_limit_reply_after_shell_output` sends a JSON frame below the limit after a 1 KiB banner and delays child exit by 200 ms. The source-extracted Rust harness rejected it before the fix. After the fix it must return the complete expected value. This uses temporary files and a bounded fixture child, not live SSH or VMs.
