# Child process cleanup follow-up

All fixtures use disposable processes and temporary files. No app, VM, package
build, production HOME, or credential store was used.

- **Fixed, `300b5d50`:** The macOS ChatGPT tar pipeline abandoned its producer
  when its consumer could not spawn. It now kills and waits for that child.
  The missing-executable regression failed with `waitpid` returning zero before
  the fix and passes with `ECHILD` afterward.
- **Fixed, `dcb08129`, hardened in `84bc5659`:** The bundle retry wrapper waited
  for a continuing command after output forwarding failed. Killing only the
  leader left bundling descendants alive. Each attempt now owns a process group;
  exceptional forwarding stops it before the leader is reaped. All stdout,
  stderr, and log failure cases pass, and a pipe inherited by a descendant
  reaches EOF. The retry suite passes 13 tests.
- **Fixed:** The release dependency-cache build abandoned its command on
  compiler-output forwarding or metadata errors. It now stops its owned process
  group and reaps its leader on exceptional exit. The output-error regression
  first failed with `build command was abandoned` and now requires a signal exit
  and `ECHILD`. All stdout, stderr, and artifact-recording error cases pass;
  the cache and retry suites pass 31 tests together.

The [Rust Child contract](https://doc.rust-lang.org/std/process/struct.Child.html)
requires explicit child cleanup. Python's
[Popen context manager](https://docs.python.org/3/library/subprocess.html#subprocess.Popen)
waits on exit but does not kill a continuing child on an ordinary exception.
Both fixes use these existing APIs, without a shared process-management layer.

The complete `TarStream` source section and its unchanged regression compile
and pass with Rust 1.94.0 against the shared target's cached dependencies.
Formatting, frontend typecheck, and frontend lint passed; the final frontend
checks used Node 24.11.1. Full-app native verification could not start while the
shared Cargo target lock was held. The extracted harness does not establish
full-app compilation or packaging.

After merging concurrent UTF-8 decoding and shell exit-status fixes, the cache,
cache integration, and bundle retry suites pass 39 tests together. The existing
integration mocks now implement the `Popen` context-manager boundary; the new
ownership regressions still use real child processes.
