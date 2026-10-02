# Native path boundaries, 2026-10-02

Four reproduced path defects were fixed and folded into `codex/integration`.
Each implementation commit includes a patch changeset. This bounded pass does
not establish that every native path boundary supports every Unix filename.

| Commit | Trigger and consequence | Correction and rejecting regression |
| --- | --- | --- |
| `ff493c1f` | A non-UTF-8 system directory in an AppImage environment variable makes `to_str` fail for the entire value. Bundled libraries remain in the environment passed to external apps. Non-UTF-8 mount roots also skip every cleanup operation. | Use native path-list parsing and component comparisons. Two regressions failed before the fix: preserve a non-UTF-8 system directory while removing a bundled entry, and remove entries under a non-UTF-8 mount with repeated/trailing slashes. Similarly named sibling mounts remain untouched. |
| `cfa508e2` | The archive/destination picker replaces invalid bytes before returning its selection through the frontend. Inspection can open a different archive, and a remembered export destination no longer matches the returned path. | Require lossless UTF-8 conversion before inspection or destination persistence. The rejection regression failed before the fix; the second test preserves spaces, Unicode and a leading-dash filename. |
| `e4bd3f9a` | Log age markers are built from `Path::display`, replacing non-UTF-8 directory bytes. Marking can fail or address a different directory, breaking retention. | Append `.started` to the native path. The byte-preservation regression failed before the fix. A Linux-only filesystem regression marks and expires a log under a non-UTF-8 directory. Update the shared MicroSandbox patch and its recorded digest as well as Silo's module. |
| `ef49053d` | The terminal command builds `MSB_HOME` and `MSB_LIBKRUNFW_PATH` from display text, silently changing unsupported path bytes. | Check the runtime home, executable and library before writing a shell command. The rejection regression failed on the original home conversion; the existing process-boundary test still receives literal paths containing spaces, quotes and shell characters. |

The standard library documents the relevant boundaries:
[`split_paths`](https://doc.rust-lang.org/std/env/fn.split_paths.html) accepts
native strings and returns paths;
[`Path::starts_with`](https://doc.rust-lang.org/std/path/struct.Path.html#method.starts_with)
compares components;
[`Path::to_str`](https://doc.rust-lang.org/std/path/struct.Path.html#method.to_str)
rejects unsupported Unicode, whereas `to_string_lossy` replaces invalid bytes.
The implementation notes are also recorded in the existing
[editor handoff](../../SiloUI-EDITOR-HANDOFF.md),
[backup testing](../../SiloUI-DEPENDENCIES-BACKUP-TESTING.md) and
[logs](../../SiloUI-LOGS.md) documents.

## Verification

- Rust 1.94.0 compiled the actual `applications/launch.rs` and
  `log_retention.rs` as standalone test modules: **13/13** and **8/8** passed on
  macOS. The Linux filesystem expiry regression was not run on this host.
- Extracted production picker and terminal seams passed **2/2** tests each.
  The terminal harness uses the production path layout, name validator and
  fixture helpers with a minimal error type; it does not compile the full app.
- Focused Clippy passed. The launch module has one existing `nonminimal_bool`
  warning in `exec_argv`; picker, terminal and retention seams pass with
  `-D warnings`.
- Node 24.11.1: `npm --prefix app/SiloUI test --
  src/test/microsandbox-runtime.test.ts` passed **13/13**, including patch
  digest and shared-source checks. The runtime/preflight Node script tests
  passed **18/18**.
- All **15** patches applied in order to a disposable copy of the exact pinned
  MicroSandbox source. The applied retention module matches Silo byte for byte.
- `npm --prefix app/SiloUI run typecheck`, `npm --prefix app/SiloUI run lint`,
  `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`
  and `git diff --check` passed. Typecheck and launch tests were repeated after
  integration changed the checkout.
- Full Cargo requests with filters `appimage_cleanup` and `backup_picker`, the
  shared `/tmp/silo-codex-target`, and synthetic GitHub configuration remained
  blocked on Cargo locks. Both owned requests were stopped with SIGTERM after
  checking their owner, executable, arguments and exact working directory.
  Full native compilation was not verified.

Evidence is local under `/tmp/silo-codex-target/verification/path-edge-*` and
`/tmp/silo-path-edge-*.log`. No app, VM, desktop picker, production state or
credential store was launched or exercised. The prepared build inputs were
linked into ignored directories; they were not rebuilt. These checks do not
qualify a packaged application or release.

## Skipped candidate

The macOS signature probe also passes `to_string_lossy` output to `codesign`.
The disposable filesystem reproduction rejected the non-UTF-8 filename with
`Illegal byte sequence` before `codesign` could run. No supported-macOS trigger
was established, so that probe was left unchanged.
