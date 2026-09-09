# SiloUI Files

Implemented 2026-09-09. Files browses `/workspace` through the bundled runtime.
The existing repository panel, sandbox filters, pane layout and folder rows remain.
No content editor, upload, download, deletion, recursive search or automatic boot
is included.

## Loading and refresh

- One directory per request, folders first, stable filename order, 200 entries/page.
- Native directory snapshots carry an ID. Further pages must match that ID; an
  expired/replaced snapshot requires a fresh listing instead of mixing scans.
- The frontend deduplicates requests and allows three concurrent loads. Cached
  folders render immediately; refresh preserves existing rows until all previously
  loaded pages succeed. First loads and pagination use skeleton rows. Failures
  show compact safe messages and Retry; pagination failures preserve current rows.
- Expanded folders refresh every ten seconds while Files is visible, and on window
  focus or visibility restoration. Collapsed/hidden folders do not poll. VM state
  or freshness changes invalidate cached data and discard obsolete responses.
- The frontend retains at most 128 inactive directory records. Native listings have
  a 20,000-entry, 1 MiB output and 2 MiB estimated allocation limit. Its cache holds
  at most 64 snapshots, expires them after 120 seconds and stays around 8 MiB.
  Exceeding limits produces a compact failure, not a false empty/complete listing.

## Native boundary

`list_workspace_directory(workspace, path, offset, snapshotId)` checks managed VM
ownership and running state. Paths are validated and passed as positional arguments,
never interpolated into shell source. GNU find lists one level with NUL-separated
records; names containing spaces, Unicode or newlines retain their identity.
The guest script checks physical directory paths and lists links without following
them. This is not a security boundary against a malicious guest concurrently moving
its directories. Non-UTF8 filenames fail safely rather than becoming lossy paths.

The existing `msb exec` can automatically start stopped VMs. A small bundled patch
adds `--no-start`, using the SDK's connect-only path. Silo bypasses its own temporary
boot wrapper for this mode and releases the GitHub update lock before reading.
Guest execution has a five-second timeout, with an eight-second outer limit; the
initial status inspection has the existing runtime read timeout.

Relevant pinned upstream source:
- [CLI execution](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/cli/lib/commands/exec.rs)
- [Rust sandbox implementation](https://github.com/superradcompany/microsandbox/tree/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/sandbox)

## Verification

- Full frontend suite: 532 tests across 56 files passed; typechecking and lint pass.
- Five native Files tests and eleven runtime packaging tests passed.
- Live isolated macOS VM: 410 entries, Unicode/newlines, links, empty/missing folders,
  permission denial and stopped-VM refusal passed. Directory command execution was
  about 12 ms, excluding Silo's initial status inspection. The disposable VM and
  its isolated storage were removed; the user's dev VM was unchanged.
- Browser checks used only the existing fixture adapter through a temporary ignored
  harness, removed afterward. Wide and narrow Files layout, expansion and stopped
  feedback passed. Production has no fixture fallback or temporary preview entry.
- Linux hardware testing remains. This evidence does not claim instant cold loading
  on every filesystem or host.

## Test in Silo

1. Start a VM normally and open Sandboxes > Files. Expand folders under its name.
2. Collapse and reopen a folder: cached rows should appear immediately.
3. Create a file using your terminal in that VM's `/workspace`. Return to Silo;
   the expanded folder refreshes on focus, or within ten seconds while visible.
4. Use a folder with more than 200 entries: Load more appends rows with skeletons
   during loading. Collapse folders or switch tabs to stop their background refresh.
5. Stop the VM normally and open Files: it explains that the VM needs starting.
   Browsing alone must never start it.

Final native verification: 223 ordinary tests passed, with five opt-in live tests
left ignored. The local HTTP-listener and filesystem-alias regressions passed in
separate permission-enabled runs. Final app checks caught and corrected the old
preflight patch pin; the checked-in-patch/hash regression now passes. Two existing
onboarding tests were updated to exercise supported CPU edits instead of renaming.

Final normal macOS bundle was rebuilt and reopened at
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`. The runtime warning was
absent. Sandboxes > Files showed `dev` with “Start this VM to browse its files.”
The VM remained stopped, and Silo was left open on Files for user testing.
