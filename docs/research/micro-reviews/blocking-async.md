# Blocking async native fix loop

Scope: native filesystem work and contended locks on Tauri's main thread or async
executor. No application bundle, real VM, user HOME, or credential store was used.

## Fixed boundaries

- `secrets::read_secrets_state`: file reads and JSON decoding now run on the blocking pool. A temporary FIFO regression failed before the fix because it starved an executor heartbeat, then passed. Native secrets suite: 23 passed.
- Remote settings commands: configuration locking, reads, fsync writes, bridge-link setup, and socket setup now run on the blocking pool. A held-lock heartbeat regression failed before the fix, then passed. Native remote setup suite: 6 passed.
- Migration reads and async runtime/checkpoint admission: migration mutex waits now run on the blocking pool. Writers hold that mutex through file and directory fsync. A held-lock snapshot regression failed before the fix, then passed. Native migration suites: 34 passed.
- Export folder picker: its saved-destination mutex read now runs inside the existing blocking worker. This is source-confirmed boundary placement; a live dialog was not exercised. Existing picker and destination tests: 2 and 8 passed.
- Repository push preflight: the displayed-count lookup now runs on the blocking pool because resolving its cache key reads the runtime-generation file and locks migration progress. Existing host-push tests: 22 passed. This is source-confirmed boundary placement; no live GitHub push was performed.

Two integration test compilation defects were also repaired: the interrupted-body
fixture lacked the deadline argument, and recovery tests referenced private sibling
fixtures. The proxy regressions passed 2 tests; the recovery suite passed 7 tests.

## Verification

Before each fix commit, Rust formatting, frontend typecheck, lint, and diff checks
passed. The three responsiveness regressions first ran as disposable harnesses
extracted from production source; their failing outputs were preserved in `/tmp`.
They subsequently passed in full native test harnesses.

The ordinary Cargo secrets run used `+1.94.0`, `--locked`, the shared
`CARGO_TARGET_DIR=/tmp/silo-codex-target`, and explicit synthetic GitHub values. It
remained queued on the shared artifact lock. Native verification instead compiled
the complete `src/main.rs` test harness with `rustc +1.94.0 --test`, the exact
shared Cargo dependency artifacts, generated ACL inputs, development cfg, and
synthetic GitHub values. Outputs are under the shared target's ignored
`verification/blocking-async/`; private command logs remain in `/tmp/silo-blocking-async-*`.
These synthetic executables must not be distributed. Compilation retained three
existing warnings. No claim is made about live VM health or release readiness.

[Tauri's command documentation](https://v2.tauri.app/develop/calling-rust/#async-commands)
places synchronous commands on the main thread and async commands on the executor.
[Tokio's blocking-work guidance](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)
provides the supported boundary used by these fixes; no scheduler or dependency
was added.
