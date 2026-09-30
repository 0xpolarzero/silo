# Native test support

Native unit tests use [shared fixtures](../app/SiloUI/src-tauri/src/test_support.rs)
instead of acquiring the production operation gate to serialize unrelated tests.

## Process-wide state

`test_support::global_state()` guards tests in modules that reach the global
operation gate, shutdown admission, GitHub caches, SSH listeners or secret caches.
It releases shutdown admission on drop, including assertion unwind. Join all
workers before dropping the guard. A worker must not acquire the test lock itself.
Tests using independent operation gates can exercise real concurrent admission
inside their guarded test. This is conservative module-level isolation, not an
injection of every production global. Keep the documented `--test-threads=1`
default for normal native checks until the full suite has been qualified on both
supported platforms. Focused parallel checks do not establish that qualification.

The storage quit regression now changes shutdown admission in the same process
under this guard; it no longer recursively launches its test executable.

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

These checks use temporary fixture data. They do not launch the packaged Silo app
or establish live VM, installed-app or release readiness.
