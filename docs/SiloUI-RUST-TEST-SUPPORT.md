# Native test support

Native unit tests use [shared fixtures](../app/SiloUI/src-tauri/src/test_support.rs)
instead of acquiring the production operation gate to serialize unrelated tests.

## Process-wide state

`test_support::global_state()` guards tests in modules that reach the global
operation gate, shutdown admission, GitHub caches, SSH listeners or secret caches.
It releases shutdown admission on drop, including assertion unwind. Join all
workers before dropping the guard. A worker must not acquire the test lock itself.
Tests with independent gates and state instances run in parallel. Keep the guard
when their helpers still reach global shutdown admission or caches. The remaining
serial group consists of guarded runtime, GitHub, SSH, network, secrets, desktop,
backup and remote tests: 531 guard sites across 19 source files. This conservative
module isolation permits concurrency within each owning test and serializes this
group inside the full parallel suite. Ordinary checks use `cargo test --locked`
with Cargo's default test thread count. Opt-in live checks retain their documented
serial commands and require separate authorization.

The storage quit regression now changes shutdown admission in the same process
under this guard; it no longer recursively launches its test executable.

The failed-Quit retry regression completes the admission change synchronously
under its guard. It no longer leaves a sleeping, unjoined worker that can change
the next test's shutdown generation. Remote operation registry tests own their
gates, so unrelated computer operations cannot split their two-VM barrier or
cancel their queued requests.

## File descriptor isolation

The seven ordinary `host_push_cache` tests each execute once in a private child
of the current test binary, selected with `--exact`. The parent verifies the child
exit status and that exactly one test passed. These children can run concurrently.
An unrelated test worker's fork can retain a sweep lock after its owning test
closes the descriptor. A mutex around only cache tests cannot exclude forks from
other modules. Shared lock references are documented in
[Apple's flock(2) manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)
and the [Linux flock(2) manual](https://man7.org/linux/man-pages/man2/flock.2.html).
A pipe-coordinated fork reproduction confirmed that parent close left the lock
busy until child exit. Separate test processes isolate the file descriptor table
while preserving the cache's real locking and intentional inherited-child test.

Keep environment overrides on child `Command` instances, filesystem state in
owned temporary directories, and listener ports allocated by the OS. A test's
workers must finish before its isolation guard or temporary directory drops.

## Full-suite qualification (K-18)

On 2026-09-30, Rust 1.94.0 on `aarch64-apple-darwin`, with 16 logical CPUs,
passed ten consecutive full default-thread runs after all isolation fixes. Every
run passed 1,033 tests and ignored 13 opt-in or subprocess-helper tests. Commands
ran from `app/SiloUI/src-tauri`, prefixed with `nice -n 10`, using the release
guide's synthetic GitHub values (`silo-test`, `test-client`, `test-secret`).
`RUST_TEST_THREADS` was unset. No suites overlapped during the timing comparison.

| Check | Full runs | Wall time |
| --- | --- | --- |
| `cargo test --locked` qualification | 10 consecutive passes | Median 65.68 s; range 62.00–67.65 s |
| Final serial comparison, `cargo test --locked -- --test-threads=1` | 1 pass | 133.06 s |
| Final `cargo test --locked` | 1 pass | 62.30 s |

The parallel median was 50.6% lower than the serial wall time on this
shared host. Both final runs passed the same 1,033 tests with 13 ignored. Earlier
exploration included one cache-lock failure; its complete output was preserved
before the file descriptor isolation fix and qualification restarted.

Logs and timing JSON remain under the ignored
`app/SiloUI/src-tauri/target/verification/k18/` directory (`parallel-11.log` for
the failure, `qualified-01.log` through `qualified-10.log`, and `final-*.log`).
Linux CI now uses the same default-thread command; Linux execution was outside
this local qualification. These fixture checks do not establish live VM or
packaged-app behavior.

## Runtime fixtures

`test_support::paths(directory)` creates the standard disposable runtime layout.
The compatibility wrappers taking `TempDir` delegate to this one implementation.

[ScriptedRunner](../app/SiloUI/src-tauri/src/test_support/runner.rs) takes ordered
`ExpectedCommand` values. Each expectation specifies exact argv and a typed
output or error, with an optional exact timeout. Unexpected reads and mutations
panic immediately. `assert_finished()` and normal drop reject unused expectations.
Use it for fixed command traces. Keep stateful fakes for behaviors such as changing
runtime identity, filesystem side effects or cancellation while a process runs.
`write_shell_script` centralizes executable installation for those process-boundary
tests; the caller still owns the temporary directory and explicit script behavior.

The desktop, checkpoint readiness/failure and application-read failure tests use
this runner. Other stateful and output-queue runners remain; the new helper does
not silently accept commands on their behalf.

## Concurrent assertions

Queue tests wait for a callback from an actual queued worker before checking
absence of its result. Backup cancellation is verified while the contending
operation still holds its turn. GitHub sleep/intent tests expose the point before
the atomic condition-variable wait, and the proxy test exposes header consumption
before allowing the next fragment. Channel timeouts bound failures; they do not
provide synchronization through elapsed time. Remote authorization tests assert
the specific rejection instead of any error. Bridge error-code migration belongs
to K-23.

## Live tests and temporary directories

Every live Rust test and the browser live-test launcher require
`SILO_LIVE_TEST_CONFIRM=disposable-test-fixtures` before external side effects.
Existing GitHub-specific authorization remains required as well. The editor
fixture home must resolve to an existing absolute directory different from
`HOME`, including symlink aliases. The nested GitHub guest regression launches
the current test executable directly, avoiding recursive Cargo target locks.

Retention fixtures remove their temporary directories on normal return and
unwind. Short `/tmp` roots remain where runtime Unix sockets require them, with
comments explaining the macOS 104-byte limit. The retention module is also
embedded in the MicroSandbox patch, so its test-only cleanup change updates that
patch and its pinned SHA. This changes the runtime preparation cache key, without
changing production retention policy.

The built-in desktop and computer-use live tests share `test_support::computer_use_live`
(one disposable `/tmp` home per test, `e2e-*` sandboxes, a registered published ChatGPT
folder). Inputs: `SILO_LIVE_TEST_CONFIRM`, a signed `msb` and libkrunfw (`SILO_TEST_MSB`,
`SILO_TEST_LIBKRUNFW`), the v4 image directory (`SILO_TEST_GUEST_IMAGE`: manifest.json and
image.tar.gz) and a published ChatGPT folder (`SILO_TEST_PUBLISHED`; `SILO_LIVE_CHATGPT_ROOT`
keeps the folder `chatgpt_app::tests::live_download_of_the_pinned_arm64_package` publishes).
`SILO_LIVE_KEEP=1` leaves a failed test's stopped home for inspection;
`SILO_LIVE_EVIDENCE` names a directory for the drive test's screenshots. The tests:

| Test | Proves |
| --- | --- |
| `live_lcu_drives_the_desktop_without_a_model` | Create to ready, `lcu status`/`doctor`, read-only mount, LCU's own MCP client drives GNOME Text Editor (typeText, paste, Save As) and a terminal (per-key), with the files verified from outside; also records memory, disk and times |
| `live_approval_switch_edits_only_the_installed_harnesses` | `auto` adds and `ask` removes exactly LCU's approval entries in Codex and Claude Code (installed from npm; `SILO_LIVE_SKIP_HARNESS_INSTALL=1` skips that phase) |
| `live_built_in_lifecycle_keeps_the_desktop_and_computer_use` | Restart, stop/start, checkpoint of the running VM, fork and in-place restore each end with the session running, computer use ready, the folder read-only and `lcu doctor` passing |
| `live_pre_v4_vm_gets_no_mount_no_desktop_and_keeps_its_flows` | A VM from the v3 image (`SILO_TEST_V3_GUEST_IMAGE`) has no mount, no desktop and no helper, and its lifecycle flows work |
| `live_built_in_computer_use_sets_up_and_survives_export_and_import` | Export and import into a second home with its own folder; the imported VM takes the destination's `ask` |
| `live_built_in_desktop_boots_repeatedly` | `SILO_BOOT_LOOP_ROUNDS` (default 3) restarts and imports with no desktop failure |

These checks use temporary fixture data. They do not launch the packaged Silo app
or establish live VM, installed-app or release readiness.
