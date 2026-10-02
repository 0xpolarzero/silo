# Remote directory micro-review: remote-dir-b

Scope: the second half, alphabetically, of files in `app/SiloUI/src-tauri/src/remote/`. The directory contains only `operations.rs`; using a floor midpoint assigns that file to this half. The initial read-only review found no new defects. The subsequent fix-loop review confirmed the finding below.

## remote-dir-b-1: Admission uses stale deadline and permission checks

**Priority:** P2.

**Location:** `app/SiloUI/src-tauri/src/remote/operations.rs:171`, `Registry::wanted`.

**Trigger:** The admission check begins before its deadline with remote management permitted, then waits for the registry mutex or pauses during a connection probe. The deadline passes or management permission is revoked before the probe returns.

**Evidence:** Before the fix, `wanted` sampled the clock and permission before acquiring the registry mutex and probing connections. Two behavioral regressions exercised the real registry and operation gate: one paused the admission connection probe until the accepted request's deadline; the other revoked permission during that probe. Both executed the fixture change and returned success instead of `EXPIRED`. The other seven registry tests passed.

**Consequence:** An unstarted remote change can be admitted after its deadline or after management permission is revoked.

**Fix:** Refresh the connection timestamp after probing, release the registry mutex, recheck permission, and sample the deadline clock immediately before returning the admission decision. Permission probes continue to run outside the registry mutex.

**Regression tests:** `a_connection_check_that_outlasts_the_deadline_never_starts_the_change` and `access_revoked_during_the_connection_check_prevents_the_change`. Both require `EXPIRED` and zero executions of the VM change. With the fix, all nine registry tests pass in the isolated source harness.

## Verification

The disposable harness compiles the actual `remote/operations.rs` with the unchanged production operation-gate code and relevant bridge-error code, using cached dependencies and Rust 1.94.0. It omits unrelated gate/bridge tests and runtime error conversions. Evidence is stored outside the repository in `/tmp/silo-codex-target/verification/remote-dir-b/`: `harness-before.log` records seven passes and the two expected failures; `harness-after.log` records nine passes. Focused Clippy through the Rust 1.94.0 `clippy-driver` reports no warnings. `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check` and `git diff --check` pass.

Full native Cargo verification and Clippy were also requested with the shared target directory and explicit synthetic GitHub configuration; their results are recorded separately when available. No app, live VM, production data, or real credentials were used. The existing R-25 remote checkpoint timeout mismatch remains excluded from this review.
