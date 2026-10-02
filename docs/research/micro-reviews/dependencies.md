# Dependencies fix-loop review

Scope: `app/SiloUI/src-tauri/src/dependencies.rs`. The deadline fix also updates its guest-image validator and the frontend dependency-store regression tests.

## DEPENDENCIES-1 · P2 · Native probe deadlines outlast the frontend watchdog

- **File:line:** `app/SiloUI/src-tauri/src/dependencies.rs:1160` in the initial reviewed source's serial `collect` path (original review: line 1133).
- **Trigger:** Six successful macOS signature probes taking 2.6 seconds each use 15.6 seconds, before host/version probes finish. Each probe stays below its native three-second deadline.
- **Consequence:** The frontend's 15-second watchdog replaces all rows with timeouts and discards the eventual complete report, including successful checks.
- **Suggested fix:** Share a native collection deadline shorter than the frontend watchdog, preserve completed results, and stop unfinished probes.
- **Regression:** Expired deadlines cannot start another subprocess; successive probes share the remaining budget; guest-image validation observes the same deadline; a partial native report arriving before the watchdog retains successful checks and specific recovery text.
- **Status:** Fixed and folded in `2947f602`. Native collection now has a 12-second budget; subprocesses and hashing consume that budget. This is a cooperative deadline around file reads, not a guarantee that a blocked filesystem syscall will return on time.

## DEPENDENCIES-2 · P2 · Manifest reads have no byte or file-type bound

- **File:line:** `app/SiloUI/src-tauri/src/dependencies.rs:238`, `read_json`.
- **Trigger:** Replace a runtime/Git manifest with a very large JSON file, or a FIFO without a writer. The original `fs::read` allocates for the entire file and blocks opening a FIFO before parsing or timeout checks. A directory also becomes an unreadable/permissions result rather than bundle damage.
- **Consequence:** A damaged manifest can exhaust application memory or strand a native dependency-check worker indefinitely. Retrying after the frontend watchdog abandons that worker can start additional blocked workers.
- **Suggested fix:** Open without waiting for FIFO writers, verify the opened descriptor represents a regular file, and bound reading before deserialization.
- **Regression:** A valid JSON object with over 64 KiB of leading whitespace is rejected while a small object remains accepted; directories are classified as malformed; a FIFO without any writer is rejected by a child-process test with a parent-enforced deadline.
- **Status:** Fixed by limiting manifests to 64 KiB plus one overflow byte and checking file type on the nonblocking opened descriptor.

## Verification

The deadline process regressions failed before implementation; the oversized-file and directory regressions also failed before their fix. Exact-source Rust harnesses under `/tmp/silo-codex-target/verification/dependencies/` passed 22 tests, including all dependency-module tests and three guest-image validation tests. These harnesses omit the unchanged Tauri command wrapper and link the shared compiled dependencies; they do not qualify the complete native application build.

The dependency-store Vitest file passed 11 tests. Node 24.11.1 typecheck, touched-file lint, and Cargo formatting checks passed for the first fix. Formatting also passed after the second fix. The focused Cargo invocation used explicit synthetic GitHub configuration and remained queued on the shared artifact-directory lock; no Cargo test result is claimed. All process/file fixtures were disposable; no app, VM, credentials, or production data was used.
