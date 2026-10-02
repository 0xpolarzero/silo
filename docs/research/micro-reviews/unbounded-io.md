# Native input bounds, 2026-10-02

Scope: native reads of files or command output whose size the user or guest can
control. Existing report findings and other micro-review ownership are excluded.
All fixtures use disposable directories; no app, real SSH keys, Keychain or VM is
opened.

Use the standard library's [`Read::take`](https://doc.rust-lang.org/std/io/trait.Read.html#method.take)
to limit bytes consumed, then check one extra byte to distinguish an exact-limit
input from a longer one. Checking `Vec::len` after `fs::read` limits parsing but
still allocates the complete file. A metadata size check alone does not cover a
file growing during a read. No dependency or general I/O abstraction is added.

## Remote-management settings

**Trigger:** `desktop-remote/config.json` grows beyond ordinary settings size,
through local editing or accumulated remote-host records.

**Evidence:** `remote::read_config_in` used `fs::read` with no byte limit;
`save_config_in` could publish settings of any size. The exact-limit/one-extra-byte
read regression and oversized-save preservation regression both failed on the
original functions and passed after the change.

**Correction:** Consume at most 1 MiB plus one byte, reject an oversized document
before JSON parsing, and impose the same 1 MiB limit before creating the writer's
temporary file. Missing-file creation and ordinary configuration parsing retain
their existing behavior. Oversized files remain untouched and the error names
the limit.

**Checks:** Source-extracted Rust tests passed 2/2 with Rust 1.94.0 and the shared
Cargo target's cached libraries. The extraction includes the production functions
and committed tests verbatim; its disposable harness and failing/passing output
are under `src-tauri/target/verification/unbounded-io/`. Native Cargo tests use
only the release guide's synthetic GitHub values and the shared target. Rust
format, TypeScript, lint and diff checks are run before folding each change.

## Computer-use settings and observations

**Trigger:** A local policy or saved guest-observation file contains more than
1 MiB, including otherwise valid JSON followed by whitespace.

**Evidence:** Both `read_policy_checked` and `read_json` used unbounded `fs::read`.
The two regressions accepted oversized policy/observation fixtures before the
fix. They now accept exactly 1 MiB and reject one additional byte.

**Correction:** Both readers use one bounded file helper, consuming at most
1 MiB plus one byte before parsing. An oversized policy retains the existing
unreadable, unknown-choice state; an oversized observation is omitted without
changing the policy. Both saved files remain untouched.

**Checks:** Source-extracted Rust regressions passed 2/2. The harness uses the
production data types and reader/settings functions verbatim, with a disposable
runtime-path fixture. Rust formatting, typecheck, lint and diff checks passed.
The full native test command remains queued on the shared Cargo artifact lock.
