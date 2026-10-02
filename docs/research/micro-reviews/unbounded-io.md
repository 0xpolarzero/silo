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

## Remote-operation markers

**Trigger:** An operation journal marker, including a legacy full-request/result
record, grows beyond 16 MiB. The read runs during registry acceptance under its
mutex.

**Evidence:** `read_marker` used unbounded `fs::read`. A valid legacy finished
record padded beyond the limit was accepted as finished by the original reader;
the regression failed before the fix and passed afterwards.

**Correction:** Consume at most 16 MiB plus one byte. Larger files follow the
existing unreadable-marker path: the operation was accepted but its result is
uncertain, and registry acceptance refuses to replay it. Missing markers still
return `None`; exact-limit legacy records still parse and files remain untouched.
The larger allowance retains compatibility with legacy request/result records.

**Checks:** Source-extracted production reader and committed regression passed
1/1. Rust formatting, typecheck, lint and diff checks passed. Native Cargo tests
remain queued on the shared target lock; no running app or VM was accessed.

## Sandbox metadata

**Trigger:** `sandboxes.json` grows above the existing 1 MiB limit.

**Evidence:** `read_metadata` checked size only after `fs::read` allocated the
whole file. An isolated child-process regression reads a sparse 128 MiB fixture,
checks the existing oversized-document error and verifies peak-RSS growth below
32 MiB. It failed before the fix with 134,283,264 bytes of additional peak RSS
and passed afterwards with 1,179,648 bytes on this Apple Silicon macOS host.

**Correction:** Open the file and consume at most the existing limit plus one
byte before checking size. Missing-file defaults, read-error classification and
oversized-document errors retain their existing behavior; no rewrite occurs.

**Checks:** The production reader and committed memory test ran in a disposable
Rust harness with adapters for unreachable parsing/validation branches. The
128 MiB rejection occurs before those adapters are invoked. Peak RSS comes from
`getrusage(RUSAGE_SELF)` in a fresh test process, avoiding the parallel suite's
prior allocation high-water mark. Exact failing/passing output is retained in
`src-tauri/target/verification/unbounded-io/`. Formatting, typecheck, lint and diff
checks passed; the complete Cargo test command is still waiting for the shared
artifact lock.

## Saved port settings

**Trigger:** The saved `network.json` input exceeds the existing 128 KiB limit,
or an input stream supplies that prefix and keeps the descriptor open.

**Evidence:** `read_config` checked size after `fs::read`. The FIFO regression
keeps its writer open until the reader rejects the oversized prefix. Before the
fix, the reader waited for the writer's five-second EOF fallback and failed the
ordering assertion; after the fix it rejects before the writer closes. A second
test retains exact-limit acceptance and one-extra-byte rejection.

**Correction:** Consume at most 128 KiB plus one byte before the existing size
and mapping validation. Missing-file defaults and read/validation errors retain
their previous behavior. The writer's existing size limit stays consistent.

**Checks:** Source-extracted production reader, configuration types, validator
and two regressions passed 2/2. Formatting, typecheck, lint and diff checks passed.
The complete native Cargo run has not completed because the shared artifact lock
remains held by another build; extracted checks do not prove full app compilation.

## Advisory backup history

**Trigger:** The remembered export-folder document grows beyond 1 MiB, including
legacy archive entries that the application no longer uses.

**Evidence:** `load_destination` read the complete document with `fs::read`. The
regression accepted an exact-limit document and still returned its destination
for a one-byte-larger document before the fix; the latter assertion now passes.

**Correction:** Consume at most 1 MiB plus one byte before deserializing. Larger
files use the existing advisory-data fallback and diagnostic: forget only the
remembered destination, preserve the document, and do not touch archives or the
separate recovery journal.

**Checks:** Source-extracted production structure, reader and regression passed
1/1. Formatting, typecheck, lint and diff checks passed. No app, live archive, VM
or production data was used. Complete native Cargo verification remains blocked
on the shared target's artifact lock; the source-extracted checks do not establish
full native compilation.
