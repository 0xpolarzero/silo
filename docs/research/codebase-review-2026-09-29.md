# Silo codebase review — 2026-09-29

Read-only review of commit `60b23ca` by 20 parallel reviewers (runtime core,
checkpoints/storage, operation gate and recovery, export/import, GitHub, host
push and secrets, remote/SSH/network, desktop and handoff, settings/updates/logs,
Linux, Rust locks and panics, guest-to-host trust boundary, frontend data layer,
application pages, shared UI, copy and terminology, frontend tests, Rust tests,
tooling/CI/docs). About 410 raw findings were deduplicated into this report.
Nothing was built, run against live VMs, or changed while reviewing.

Legend: **✓** re-checked in the code by the consolidating reviewer · **(2×/3×)**
found independently by several reviewers · **suspected** depends on runtime or
OS behaviour that was not observed. Line numbers refer to `60b23ca`; work that
landed after it may already address some items.

Checks at review time: `typecheck` and `lint` passed (7 `only-export-components`
warnings); 1012 of 1014 frontend tests passed (the 2 failures came from
uncommitted in-progress work renaming the sandbox "Access" tab to "SSH").

## Owner decisions (settled 2026-09-29)

The owner reviewed these items on 2026-09-29. Nothing has been implemented; this
section records the agreed direction. Every other finding in this report is
accepted as a bug to fix without changing intended behaviour.

1. **Host Push (security) — accepted.** The host currently re-reads repository,
   branch and commit from the guest after the user clicks Push, then mints a write
   token (including `workflows`) even for a sandbox whose grant is read-only.
   - Bind each push to the repository, branch and commit shown in the UI; abort
     if the guest reports anything else.
   - Show a confirmation naming the repository and branch before pushing.
   - Require the repository to be write-granted to that sandbox.
   - Mint host-push tokens with `contents: write` only (no `workflows`) and revoke
     them after the push.
2. **Remote-management SSH key (security) — accepted.** Install Silo's key with
   `restrict,port-forwarding,permitopen="127.0.0.1:*",command="exec ~/.local/bin/silo-remote --remote-bridge"`.
   Silo only uses the key to run the bridge (`remote.rs:383`, `:635`) and for
   `-N` tunnels to `127.0.0.1` (published ports, desktop viewer), so no feature
   changes. Existing remote computers need no user action: Silo rewrites its own
   `authorized_keys` line over the current connection the next time it connects.
3. **"Disable access" — accepted as a global kill switch.** Disable access
   detaches every sandbox's GitHub access (OAuth and personal token) and blocks
   host push.
4. **Secret domain wildcards — no change.** Choosing allowed domains is the
   user's responsibility; users should allow specific subdomains rather than
   wildcards on shared suffixes such as `*.github.io`.
5. **Editor handoff — accepted.** VS Code Remote-SSH runs a helper server inside
   the sandbox connected back to VS Code on the host; guest code can use it to
   obtain the host VS Code's GitHub session for `git` and to auto-forward guest
   ports to host `localhost` (from code and documentation; not tested against a
   hostile guest).
   - Launch VS Code for Silo sandboxes with a dedicated "Silo" profile that sets
     `github.gitAuthentication: false`, `git.terminalAuthentication: false` and
     `remote.autoForwardPorts: false`, leaving the user's normal profile
     untouched.
   - Document the remaining trust expansion in `SiloUI-EDITOR-HANDOFF.md` and
     check Zed's equivalent behaviour.
6. **Delete sandbox — accepted.** One dialog, identical from the list row and the
   sandbox page:
   - Title: "Delete {name} permanently?"
   - Body: "Its files ({size}) and {n} checkpoints will be deleted. This can't be
     undone."
   - **Export, then delete**: choose a file, export, verify; delete only if the
     export succeeded.
   - **Delete permanently** (destructive style) and **Cancel**.
7. **Quit confirmation — accepted.** When sandboxes are running, show "Quit Silo?
   This stops {n} running sandboxes: {names}." with **Quit and stop** /
   **Cancel**; no prompt when nothing is running. Applies to the tray power
   button, ⌘Q and menus, macOS Dock Quit (requires handling
   `applicationShouldTerminate:`), and Linux window close when no tray is
   available. Logout and shutdown must still stop sandboxes gracefully.
8. **Confirmation policy — accepted.**
   - Stop/Restart a running sandbox: always confirm, using the tray's inline
     confirmation, everywhere (list row, page header, command palette, menus).
   - Delete sandbox: always the dialog in decision 6.
   - Remove a port, secret or computer: inline two-step confirmation in
     destructive style.
   - Start and Open: never confirm.
   - Labels end with "…" only when a confirmation or dialog follows.
9. **Checkpoint storage — accepted.** Add a Delete checkpoint action (confirmed,
   respecting checkpoints that forks depend on); remove native snapshots when a
   sandbox is deleted or a capture or import fails; show checkpoint storage in
   the Storage tab.
10. **Terminology — accepted.** Use this glossary in all user-facing text (UI,
    notifications, tray and native menus, backend messages, help):

    | Concept | Say | Stop saying |
    |---|---|---|
    | A Linux VM Silo manages | **sandbox** | VM, virtual machine, machine |
    | A machine connected over SSH that Silo doesn't manage | **SSH host** | SSH machine, machine |
    | The `/workspace` folder and its disk | **workspace** (only this meaning) | workspace for the sandbox itself |
    | A physical machine running Silo | **computer**; the local one is "this computer", others by name | "this computer" for a remote one, host |
    | Saved state of a sandbox | **checkpoint** | snapshot, saved state |
    | Rewind a sandbox to a checkpoint | **Restore** | "restore" for anything else |
    | New sandbox from a checkpoint or current state | **Fork** — "a new sandbox with a copy of its files" | clone, copy |
    | New empty sandbox with the same settings | **Duplicate settings** | Duplicate |
    | Sandbox to file, and back | **Export** / **Import**; the file is an **export file** | backup, archive, restore |
    | SSH into a sandbox | **SSH access** | Access |
    | Remote computer states | **Offline** / **Updating…** | Unavailable, busy, Applying VM changes |

    Optional later: rename the `.silo-backup` extension to `.silo-export` while
    still importing the old one.
11. **Versioning — accepted.** Silo stays pre-1.0; the first stable release
    happens only when the owner explicitly decides.
    - Facts: 1.0.0 was never published (latest GitHub release is 0.9.0). A
      mistaken "Release Silo 1.0.0" commit (`c305d4d`) was corrected to 0.9.0 in
      `1890947`, but the `v1.0.0` tag (`bd721d6`, local and on GitHub) and
      `docs/releases/1.0.0.md` remain. Root cause: `AGENTS.md` tells agents to use
      `major` for incompatible changes, and Changesets turns a pre-1.0 `major`
      into 1.0.0.
    - Change `app/SiloUI/.changeset/runtime-checkpoints-migration.md` to `minor`,
      so the next release is 0.10.0.
    - `AGENTS.md`: before 1.0, breaking changes use `minor`; `major` only when the
      owner explicitly decides to release 1.0.0.
    - Release tooling refuses any version ≥ 1.0.0 unless an explicit flag is
      given, checked before `changeset version` consumes the changesets.
    - Delete the stale `v1.0.0` tag (local and GitHub) and
      `docs/releases/1.0.0.md` (approved by the owner).
12. **CI — accepted: a GitHub Actions workflow on push to `main` and on pull
    requests** (not a local git hook).
    - Fast job: typecheck, lint, frontend tests, all release-script tests
      (including the ones currently never run), `website/` and `demo/`
      typecheck, and a check that `build.rs`'s command list matches the handlers
      registered in `main.rs`.
    - Rust job: `cargo test --locked -- --test-threads=1` on Linux with the
      synthetic GitHub configuration release CI already uses.
    - Linux packaging (bundle plus `package-debian-release.py`) only when
      packaging files change, or nightly.
    - `cargo fmt --check` report-only until a one-time reformat is scheduled
      while no other work is in flight.

## 1. Release blockers

- **Linux .deb assembly will fail on the next release** ✓ —
  `app/SiloUI/src-tauri/tauri.linux.package.conf.json` sets `externalBin: []` and
  installs tools to `/usr/libexec/silo/tools`, while
  `app/SiloUI/scripts/package-debian-release.py:15-18` still requires
  `usr/bin/msb` (run in `.github/workflows/release-platform.yml:305`). Introduced
  in d654e4b after the last tag; `test_debian_release.py` fixtures still use
  `usr/bin`.
- **`reveal_backup_archive` missing from the app manifest** ✓ —
  `app/SiloUI/src-tauri/build.rs` omits it although it is registered, granted and
  invoked. A stale local autogenerated permission file masks this; a clean build
  is expected to fail permission validation (not reproduced).
- **Unintended 1.0.0 bump** ✓ — `app/SiloUI/.changeset/runtime-checkpoints-migration.md`
  is `major`, which Changesets turns into 1.0.0; the stale `v1.0.0` tag and
  `docs/releases/1.0.0.md` also make `release:version` fail half-way (changesets
  consumed before `sync-release` validates). See owner decision 11.
- **Website and demo builds broken** ✓ — `website/src/demo/read-only-demo.tsx:11`,
  `demo/src/release-backup.tsx:5` and `demo/src/preparation.tsx:16` import the
  deleted `backup-page`. No CI job builds `website/` or `demo/`.

## 2. Security

- **Host Push destination chosen by the guest** ✓ (3×) —
  `app/SiloUI/src-tauri/src/host_push.rs:654-676`,
  `app/SiloUI/src-tauri/src/github.rs:1272-1318`,
  `app/SiloUI/src-tauri/src/github_tokens.rs:199-221`. Bind the job to the
  repository/branch/commit shown in the UI; mint `contents: write` only; revoke
  after use.
- **Unrestricted remote-management key** ✓ — `app/SiloUI/src-tauri/src/remote.rs:18`,
  `:313-330`.
- **GitHub narrowing short-circuits** ✓ —
  `app/SiloUI/src-tauri/src/github_personal_token.rs:138` (`?` inside the detach
  loop) and `github.rs:1206` (`narrow_now` returns before OAuth narrowing). One
  failing VM leaves every other VM with its token. Related: one VM's narrowing
  error blocks renewal for all VMs (`github.rs:727-772`); cache entries for
  deleted VMs are never pruned.
- **Disable access ignores personal-token VMs** — `github.rs:772-773`, `:977`,
  `github_personal_token.rs:132-136`.
- **GitHub grants keyed by sandbox name, not cleared on delete** (3×, suspected) —
  `app/SiloUI/src-tauri/src/runtime.rs:64-66` (`GITHUB_PROFILES`) and policies in
  `github.json`. A new sandbox reusing a name may inherit grants.
- **Public-suffix secret wildcards** (2×) — `app/SiloUI/src-tauri/src/secrets.rs:284-300`,
  `app/SiloUI/src/features/application/model/secret-configuration.ts:21-28`.
  Owner decision 4: no change; allowed domains are the user's responsibility.
- **Secrets in process environments** — `SILO_GITHUB` (`runtime.rs:1634`) and
  `GIT_CONFIG_VALUE_0` (`host_push.rs:267-279`) are readable by same-user
  processes; host-push tokens are not revoked. Secret names become host `msb`
  environment variable names guarded by a denylist copied three times.
- **Release signing key exposure** — `TAURI_SIGNING_PRIVATE_KEY` is job-level env
  (`release-platform.yml:178`), visible to `npm ci`, build scripts and
  proc-macros; the verbose bundle log is uploaded as an artifact on failure
  (`:275-280`).
- **Import trusts the snapshot's embedded config** (suspected) — the manifest
  config is validated but `msb restore` uses the snapshot's
  (`backup.rs:1205-1214`, `runtime/checkpoints.rs:1019-1066`).
- **Other** (suspected or lower impact): desktop tunnel port can be pre-bound by
  a local attacker (`desktop_viewer.rs:85-118`); `http://127.0.0.1:PORT` pages
  share cookies with other loopback services; a >1 MiB guest console record
  disables all log queries for that sandbox (`runtime_logs.rs:452`); guest
  `remote:` stderr is shown in push errors; APT re-signs `.deb`s verified only
  against the same release's `SHA256SUMS`; workflow actions pinned by tag.

## 3. Data loss and destructive actions

- **Delete copy contradicts behaviour** ✓ —
  `app/SiloUI/src/features/application/pages/sandbox-detail-page.tsx:498`,
  `overview-page.tsx:126` vs `runtime.rs:3284-3285`.
- **Remote sandboxes addressed by bare name** ✓ — command palette
  (`application-commands.ts:55-67`) and tray menu (`native-workspace-menu.tsx:25-36`)
  pass `machine.name`, so actions on a remote `dev` hit a local `dev`. The status
  panel's Open site calls local `open_network_port` for remote targets
  (`production-source.ts:1270`), which always fails ✓. The fork toast and the
  sandbox page's Secrets section also match by name.
- **Sandbox page state leaks across sandboxes** ✓ — `overview-page.tsx:448`
  renders `SandboxDetailPage` without `key`; an open Delete/Edit dialog then acts
  on the next sandbox.
- **Onboarding can emit deletes for existing VMs** ✓ (mechanism) —
  `onboarding-app.tsx:164` seeds the draft once from defaults if application
  state has not loaded (`production-onboarding.tsx:35`); Continue derives deletes
  (`machine-change.ts:88`). Requires an existing user to land in onboarding, e.g.
  after a settings reset.
- **Snapshot storage never reclaimed** ✓ — no `snapshot remove` anywhere;
  "Before restore" and "Fork point" snapshots, deleted sandboxes' snapshots and
  failed `silo-import-*` groups accumulate. The 1 MiB snapshot-index cap
  (`backup.rs:162-166`) eventually breaks export, import and checkpoints.
- **Restore stuck in the capturing phase** — `runtime/checkpoints.rs:1444-1466`:
  if pause fails or the host crashes mid-capture, Start/Stop stay blocked and the
  only exit is deleting the sandbox.
- **Debian upgrade guard checks the wrong path** ✓ (2×) —
  `app/SiloUI/scripts/debian/preinst:11` looks for `/usr/lib/Silo/bin/msb`;
  the runtime is at `/usr/libexec/silo/tools/msb` (`bundled_tools.rs:32-35`).
- **Quit paths** — macOS Dock Quit/logout skip `ExitRequested` (tao lacks
  `applicationShouldTerminate:`); Linux has no SIGTERM/logind handling; Linux
  without a tray turns window close into a full Quit (`main.rs:231-236`); the
  tray power button quits in one click (`status-bar.tsx:249`).
- **Other**: a retried fork/restore Start removes a previous attempt that may
  have run (`checkpoints.rs:984-1009`); checkpoint export pairs the old disk with
  current config (`backup_controller.rs:926-951`).

## 4. Reliability: stuck and frozen states

- **Failed configuration change freezes the list until relaunch** ✓ (2×) —
  `runtime/configuration_recovery.rs:278-289`: the journal stays after an
  in-session failure and every state read returns
  `SILO_SANDBOX_UPDATE_IN_PROGRESS`.
- **Global idle check freezes all sandboxes** ✓ (2×) — `operation_gate.rs:423`
  (`is_idle` counts hidden housekeeping and every VM) used by
  `runtime.rs:1810-1825`. An UPDATING reply can also overwrite a fresher
  in-flight read in the frontend.
- **Desktop viewer deadlock** ✓ (2×) — `desktop_viewer.rs:297-338` holds the
  `VIEWERS` mutex across `connect()` (up to 600 s remotely) and `add_child`
  (which waits on the main thread); the `Destroyed` handler (`:201-206`) takes the
  same lock on the main thread.
- **Export/import recovery** — a failed recovery permanently blocks startup
  recovery, auto-start and updates with no UI escape
  (`backup_controller/recovery.rs:249`, `:571-615`, `startup.rs:109-113`); import
  crash recovery never runs in production (`save_restore_identity` and
  `claim_disk` only called from tests) ✓; `update_guard`'s unresolved check can
  never be true (`backup_controller.rs:2829-2839`) ✓; a crashed export re-runs on
  launch and force-starts VMs (`recovery.rs:582-616`).
- **Updates blocked** — any unstarted fork blocks all app updates
  (`runtime/update_recovery.rs:111-116`) ✓; an update-recovery entry for a
  deleted VM blocks auto-start and updates forever (`:180-199`).
- **Cancelled Quit disables all edits** ✓ (3×) — `production-source.ts:863-866`
  never resets `acceptingSetup`.
- **Write-protected settings** ✓ — `settings.rs:150-152` returns
  `protected_error` before checking `dirty`: Quit impossible, updates fail,
  terminal/editor open fails, notifications drop.
- **Remote computers** — remote lifecycle failure marks the whole computer
  offline and drops the message (`production-source.ts:645-648`) ✓; global
  `REQUEST_LOCK` serializes all remote mutations for up to 2100 s
  (`remote.rs:808-817`); one failed poll tears down all tunnels and desktop
  viewers for that host (`remote.rs:536-541`, `remote_network.rs:53-96`); one
  slow host stalls every host's refresh (`Promise.all`); `accept()` error ends the
  owner loop (`remote.rs:699`).
- **Errors hidden after load** ✓ — `snapshot.error` is only rendered when there is
  no source (`production-surface.tsx:71-74`), so openDesktop, GitHub reopen and
  remote failures show nothing; conversely, one transient read failure without
  remotes replaces the loaded UI with a full-screen error
  (`production-source.ts:487-488`).
- **Linux desktop viewer** ✓ — `linux-desktop-state.ts:23` rejects
  `lcuReadiness: "failed"`, which `desktop.rs:321-323` forwards; the viewer
  becomes unusable. The viewer also attaches before the stream is running.
- **Cancellation** — cleanup `stop` killed by the same token leaves VMs running
  (`runtime.rs:804-837`); cancelling restart kills `msb stop` mid-stop; cancelled
  start intents are auto-resumed at next launch (`lifecycle_recovery.rs:146-229`);
  export/import cancel uses SIGKILL (`backup.rs:141-154`).
- **Other**: personal-token validation stops retrying after ~3 minutes offline
  (`github_http.rs:86-124`); host-push journal never pruned (hard fail at 10,000
  jobs), frontend push polling every 2 s forever on errors, and a global
  push-cache lock; no single-instance guard on Linux and any `remote::start`
  error aborts launch (`main.rs:214`); migration failure write discarded with
  `let _` leaves status "running" (`runtime_migration.rs:602-609`).

## 5. Performance

- **Duplicate polling** ✓ — the hidden status-panel webview runs its own
  production source (`main.tsx:25`), polling every 10 s like the main window;
  `refreshComputers` (SSH per remote) runs even when hidden; each of ~35
  `application-state-changed` emit sites refreshes both webviews.
- **`read_application_state` cost** — `list` + N× `inspect`, hidden housekeeping
  re-inspecting stopped VMs and running log retention, per-VM guest `find` and
  `git status` serially behind a 15 s cache without single-flight
  (`runtime.rs:1719-1741`, `host_push.rs:124-172`); can block up to 180 s on a
  GitHub revision lock (`runtime.rs:776-789`).
- **Sync commands on the main thread** — `read_backup_state` (`statvfs` on the
  export folder under a lock), `remote_setup_ssh_key`/`remote_authorize_ssh`
  (LaunchServices enumeration), `remove_remote_host`, migration commands,
  `set_update_automatic_checks`; Ghostty AppleScript on the main thread.
- **Other** — log Follow re-reads and hashes up to 250 MiB per sandbox every 3 s
  (`runtime_logs.rs:380-560`); import hashes the archive three times; GitHub
  worker polls at 10 Hz reading its config (`github.rs:1576-1719`); SSH monitor
  spawns `msb inspect` every 2 s per enabled VM; activity journal fsync-rewritten
  per progress event (`runtime.rs:2450-2477`); `publish()` rebuilds every
  workspace and `useProductionSource` returns a new object each render.

## 6. UX and copy

- Stop/Restart one click in the main window and palette, confirmed in the tray;
  palette and tray bypass the memory-pressure start guard.
- Raw runtime stderr, "exit code N" and "worker failed" shown as the error;
  "Check Silo's Dependencies screen" points to an onboarding-only screen.
- Terminology: "This computer" means both local and remote; five names for a
  sandbox; export/import mixed with backup/restore/archive/snapshot (an export
  failure toast reads "Restore failed"); SSH has three meanings.
- SSH panel shows and copies `root@host:port` (user is `silo`, syntax invalid)
  (`ssh-access-panel.tsx:102-104`) ✓; enabling network SSH has no warning.
- Machine editor ignores host capacity (defaults fail on smaller Macs); CPU field
  exceeds the backend's `u8`; inputs stay editable while saving.
- Restore dialog omits that a running sandbox is paused, memory-captured and
  force-stopped; current-state Fork silently adds a permanent checkpoint.
- Import "Checking export" dialog reopens after being closed; import Cancel
  promises cleanup that does not happen.
- List rows are `role="button"` wrapping real buttons (Cancel/Dismiss also open
  the page) (`list-row.tsx:46-54`); rows cannot be opened during long operations.
- Operation-queue toast unmounts outside the Sandboxes section; its Cancel
  targets an unnamed entry.
- Disabled buttons without reasons; essential information only in tooltips;
  four empty-state styles; tray ignores lifecycle failures.
- Linux first run: no default terminal; default editor resolves to apps the
  handoff rejects (Xcode, GNOME Text Editor).
- `app/SiloUI/docs/silo-help.html` describes removed UI and wrong labels.
- Health notifications fire for changes the user just made.

## 7. CI, release and docs

- Frontend tests/typecheck/lint only in `release.yml` on tags; cargo tests only on
  PRs and releases; no fmt/clippy gate (`cargo fmt --check`: 718 diffs).
- Script tests not run in CI: desktop service, LCU, Luda, migration,
  `zcode-tls.test.mjs`.
- `AGENTS.md`: `src-tauri/tests/` does not exist; Go 1.25 prerequisite missing.
- Stale docs: `SiloUI-NATIVE-MENUS.md`, `SiloUI-DEPENDENCIES-BACKUP-TESTING.md`,
  `README.md` still describe the Backup tab; ~20 evidence links point into the
  ignored `target/verification/`; `docs/README.md` lists superseded plans as
  current and misses ~24 documents.
- ~56 MiB of film renders and a `.vite` cache tracked under `artifacts/`;
  `.claude/` untracked and not ignored (blocks `release:draft`); no
  `rust-toolchain.toml`.
- `release:version` is not atomic; `release:draft` does not check HEAD is on
  `origin/main`.

## 8. Tests

- `application-app.test.tsx` (55 s) and `onboarding-app.test.tsx` (40 s) set the
  suite's wall time; splitting them cuts ~57 s to ~30 s.
- Fake bridges return `undefined` for unknown commands; application state is
  partly `z.unknown()` with no Rust-emitted golden JSON for application state,
  remote snapshots, SSH or network; fixtures are mutated in place; the real Tauri
  `listen` throws in tests and is swallowed.
- Rust tests only pass serially (shared globals); 31 hand-written runner fakes;
  ~90 assertions on message strings.
- Untested risky paths: fork rollback, `runtime_migration::convert`, remote
  bridge `dispatch`/`authorize`, `apply_github_policy`, deleting a sandbox with a
  pending restore; secret cleanup is silently skipped in tests.

## 9. Code health

- Minified code: `workspace-storage-panel.tsx`, `host_push.rs:776`,
  `host_push_operations.rs`, `package-debian-release.py`.
- Dead code: ~500 lines of the backup sparse-volume path; the export
  "restart-required" path end to end; the unused `push_repository` command (still
  granted); the `StatusBar` popover used only by tests; `use-media-query.ts`.
- Stringly-typed errors: inconsistent sentinel matching (`===` vs `.includes`),
  two disagreeing keyword classifiers, cancellation detected by message text.

## 10. Checked and sound

Desktop proxy authentication (token cookie, Host and Origin checks); tunnels and
published ports bind loopback only; no command injection in SSH or AppleScript
quoting; file-listing path traversal blocked; no `dangerouslySetInnerHTML`;
operation-gate condvar/FIFO logic and poison recovery; updater signature checks
and no-downgrade comparator unchanged by the vendor patch; runtime and guest
downloads hash-pinned; recent user-visible commits have changesets; closing the
window without a tray does go through the graceful Quit path.
