# System integrations fix loop

Scope: `app/SiloUI/src-tauri/src/system_integrations/` and `system_shutdown/`.
Worktree: `.claude/worktrees/codex-fix-system-integrations`.
The original findings remain in the separate shared review worktree's
`docs/research/micro-reviews/system-integrations.md`.

## Fixes

- **SYSTEM-INTEGRATIONS-1:** `ffbf104c` serializes Linux replacement lookup,
  delivery, publication, and withdrawal through the production `NotificationIds`
  seam. The original behavior failed with two active same-key notices; the fix
  leaves one and deletion closes it. `1545dc78` adds the in-flight replacement
  versus deletion regression. A mutation restoring the unlocked send fails that
  test by leaving a notice alive after deletion. Both commits were folded.
- **SYSTEM-INTEGRATIONS-2:** `31b210fe` binds every cached ID to its unique
  D-Bus server owner and addresses method calls to that captured owner. Both
  restart regressions failed before the fix: deletion closed the new key and
  replacement overwrote another notice. Both pass after the fix. Folded.

Each behavior fix includes a patch changeset. The existing notification design
notes record the standard protocol and the owner-specific method addressing.

## Verification

- Compiled the actual production `notification_ids.rs` as a module with
  `rustc +1.94.0 --edition=2021 -D warnings --test` into the shared
  `/tmp/silo-codex-target`. All four fake-server tests passed. They exercise
  notification delivery and withdrawal, including overlapping calls and reused
  IDs, without accessing a desktop service or application state.
- Ran `rustup run 1.94.0 clippy-driver --edition=2021 --test - -D warnings`
  against that module: passed.
- Ran `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`
  and `git diff --check`: passed.
- The focused Cargo test request uses the prescribed shared target and explicit
  synthetic GitHub configuration. It never acquired the shared artifact lock
  during this loop and was stopped with SIGINT after verifying its executable,
  owner, worktree, test arguments, and absence of child processes. Native Cargo
  compilation and test results are unavailable.
- No frontend code changed, so frontend typecheck/lint are not applicable.
- This macOS host has no GIO development installation. The Linux GIO adapter was
  checked against the pinned `gio 0.18.4` method signatures, but was not compiled
  or exercised against a Linux session bus. These tests do not prove live desktop
  notification behavior. No app, real VM, production data, or real credentials were
  accessed, and no packaged bundle was inspected.

The second pass found no additional confirmed scoped defect. Integration also
contains a separate router-level fix for queued delivery and withdrawal ordering. The installed Apple
SDK's Apple-event constants match shutdown routing. Tauri's setup callback runs
synchronously within tao's application launch callback, before it returns, so the
notification delegate installation satisfies the SDK's launch ordering.
