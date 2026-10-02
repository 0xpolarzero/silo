# Built-in Linux desktop and computer use: plan

Status: approved 2026-10-01; the backend integration (sections 3 to 5) is implemented
and verified live (2026-10-02, see the evidence in [ChatGPT app](SiloUI-CHATGPT-APP.md#integration-2026-10-02)). This replaces the optional,
per-VM desktop installation described in [Linux desktop](SiloUI-DESKTOP.md)
for new VMs, and replaces Luda with [LCU](https://github.com/0xpolarzero/lcu).

## Goal

A new VM has a Linux desktop and agent computer use ready with no setup: a
user creates a VM, starts an agent (Claude Code, Codex, Pi, OMP or Hermes), and
the agent can use the desktop immediately. The only prompts are the harness's
own approvals, which a per-VM switch can turn off for computer use.

## Decisions

- The desktop is part of every new VM, baked into a published v4 guest image.
  It starts with the VM because LCU needs a running Xfce session.
- Silo never publishes OpenAI files. Every computer that runs Silo downloads
  the official ChatGPT Linux `.deb` from OpenAI by itself, in the background,
  and keeps one read-only copy shared by all VMs on that computer. Owner
  decision 2026-10-02: no consent prompt, notice or setting. The app tells the
  user in one sentence (Settings, bundled help) and shows the state per
  computer in Settings, Computers. Downloading never blocks creating or
  starting a VM; a failure retries with backoff and can be retried by hand.
- Silo pins a tested pair: an LCU release and a ChatGPT app version with
  per-architecture SHA-256. The owner updates the pair by hand after testing.
  No automatic tracking of new ChatGPT releases.
- The pinned app copy is private to LCU: mounted read-only at a Silo path, not
  `/usr/lib/chatgpt`, not installed through dpkg, with no apt source and no
  launcher. A user who wants ChatGPT in a VM installs it normally; that copy
  never affects LCU.
- Per-VM approvals switch, off (ask) by default.

## Evidence (2026-10-01)

Measurements and tests are in [guest image size](SiloUI-GUEST-IMAGE-SIZE.md)
and were reproduced by parallel investigations; the summaries below are the
facts the plan depends on.

- **Shared storage.** MicroSandbox 0.7.4 stores an image once in a
  content-addressed cache; each VM adds a sparse overlay disk (about 4 MB when
  created). A read-only host directory mount (`-v DIR:GUEST:ro`) is enforced
  by the host: writes fail with EROFS even after a guest remount. About 215
  test boots with Silo-like sizing and the 1.5 GB app mounted showed no hangs.
- **v4 image size** (desktop, Selkies, ChatGPT and LCU system libraries,
  accessibility defaults; no OpenAI files): arm64 389 MB gzip / 1.24 GB
  uncompressed; amd64 400 MB / 1.31 GB. The v3 base is 86 / 89 MB gzip.
- **ChatGPT app.** OpenAI's apt repository
  (`https://persistent.oaistatic.com/codex-app-prod/linux/deb`, suite
  `stable`) is signed by key `3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4`
  ("Codex Linux Repository"); its index lists the latest version's SHA-256 and
  older versions remain downloadable from the pool. Version 26.928.31416:
  arm64 453 MB download, about 1.5 GB unpacked, 4,504 paths, no case
  collisions, no setuid files. macOS `/usr/bin/tar` extracts `data.tar.xz`
  from the `.deb` directly.
- **App versions are dates** (`26.928.31416`) and the CUA runtime is `0.0.x`;
  neither signals compatibility, so pinning is by tested pair.
- **No runtime approvals on Linux.** The ChatGPT CUA runtime's Linux action
  modules have no approval code; an end-to-end LCU 0.7.0 run from a read-only
  app (doctor, window list, screenshot, typing and Save with an independent
  file check) produced zero elicitation requests.
- **Harness approvals** (LCU's MCP server is named `lcu`; the `js` tool has no
  annotations):

  | Harness | Default | Setting that removes the prompt |
  | --- | --- | --- |
  | Claude Code | asks | `permissions.allow: ["mcp__lcu"]` (tested, 2.1.204) |
  | Codex | asks (`exec` fails under approval policy `never`) | `[mcp_servers.lcu] default_tools_approval_mode = "approve"` (tested, 0.159.3) |
  | OMP | no prompt (`yolo` default) | `tools.approval.js: allow`, `js_reset: allow` for users in other modes |
  | Pi | no permission system | none |
  | Hermes | no gate on plugin tools without a `pre_tool_call` hook | none |

- **Accessibility.** GTK and Qt expose trees by default. Firefox needs
  `org.a11y.Status.IsEnabled`, set durably by the dconf default
  `toolkit-accessibility=true`. Chromium and Electron expose web content only
  after an AT-SPI client calls `GetAttributes`/`GetRelationSet`
  (`OnExtendedPropertiesUsedInWebContent`); a small autostarted poller makes
  Chrome 154 expose 242 nodes (same as `--force-renderer-accessibility`),
  versus 4 without it. No environment variable or policy does this.
- **Editor.** GTK 3.24 `gtk_text_view_accessible_paste_text` passes a stack
  pointer to an asynchronous clipboard callback; AT-SPI `PasteText` with an
  external clipboard owner crashes every GTK3 text view (Mousepad, gedit,
  l3afpad). GNOME Text Editor (GTK4, 5.7 MiB) passes paste, insert and set.
- **MicroSandbox.** Restore never carries host mounts on disk snapshots; they
  must be passed again with `msb restore -v`. `msb modify` cannot add mounts.
  Mount roots through a symlink are refused by design (late, unclear error).
  0.7.5 fixes an `msb exec` piped-stdin hang (#1549) and adds `--no-stdin`;
  open issues #1701/#1702 report that the first statfs on a large read-only
  mount walks the whole host tree.

## Work

### 1. LCU

1. Use the installed Linux app in place instead of copying it (done in
   `1dc06ac`).
2. Record tested app/runtime pairs; `setup` and `doctor` report tested or
   untested, warning without blocking.
3. An approval mode for setup that adds or removes only LCU's own entries in
   each harness (table above), reversibly.
4. Release.

### 2. MicroSandbox upgrade

Upgrade the bundled runtime from 0.7.4 to the latest release (0.7.6), carrying
Silo's patches forward, mainly for the exec stdin fix. Review renamed commands
and flags (`branch` → `fork`, `--forked` → `--cow-mem`; old names remain
deprecated aliases) and path handling changes (relative host paths become
absolute).

### 3. v4 guest image

- Desktop recipe (Xfce, Selkies 2.0.0) installed at image build.
- ChatGPT runtime dependencies and LCU system packages, so LCU installs with
  `--skip-system --offline`.
- Pinned LCU release archive, hash-checked, staged for installation in the VM
  (done: `guest/lcu-lock.json`, LCU 0.8.1, `/usr/local/share/silo/lcu/`).
- Accessibility: dconf `toolkit-accessibility=true` system default and an
  autostarted AT-SPI attribute poller for Chromium/Electron.
- GNOME Text Editor as the `text/plain` default instead of Mousepad.
- Build with bind mounts, never `COPY` of a package that is later deleted.

### 4. ChatGPT app on each computer

- Lock: app version, per-architecture SHA-256 and runtime version, plus the
  LCU version and SHA-256.
- No notice or consent: the download starts by itself (decision of 2026-10-02).
- Download the exact pinned version from OpenAI's pool; verify SHA-256.
- Extract only `usr/lib/chatgpt` (macOS `tar`, Linux `dpkg-deb -x`); never run
  maintainer scripts. Refuse case collisions, setuid/setgid files, absolute or
  escaping paths and links leaving the tree. One immutable folder per version
  in a per-channel Silo data directory; publish atomically; delete the `.deb`.
- Pass canonical paths to MicroSandbox.
- Every computer does this itself at its own start, remote ones included; a
  controller never prepares an app for another computer.

Done: lock (`lcuVersion` 0.8.1), download, verification, extraction and
publication under `<app data>/chatgpt/published/`, started automatically at app
start with retries (2026-10-02, replacing the one-time notice), cached status
reads and a computer-level Retry. See [ChatGPT app](SiloUI-CHATGPT-APP.md).

### 5. VM integration

Done (see [built-in computer use](SiloUI-DESKTOP.md#built-in-computer-use)):
mount at creation and on every restore (verified), boot and app-ready sync,
approval modes, `setup-computer-use`, `computerUse` desktop state, garbage
collection of unused versions. Decisions: the guest step is pushed and started
by the host after every boot (`prepare_booted`) and when the app becomes ready
while VMs run, rather than by a guest boot hook, so the helper always matches
Silo; garbage collection runs at start and after a prepare, only while no VM
runs, and holds the computer-wide operation gate (which every VM start takes)
from the inventory through the deletion, skipping when any operation is active or a download holds the storage lock (it never waits for either); a skipped pass stays pending and is retried every two minutes until it ran.
Pushing the helper happens on a host background thread, never inside Start: it
first checks the VM is still the same running instance, then reads the approval
policy at launch time.

- New VMs are created with a stable per-computer folder mounted read-only at
  `/opt/silo/chatgpt`. That folder holds only verified, published version
  folders (staging, downloads and records live elsewhere) and is garbage
  collected, which keeps the first-statfs walk (#1701/#1702) small. It exists,
  possibly empty, before any VM starts, so a VM created before the automatic
  download finished gains computer use later, and a pinned-version change
  reaches existing VMs at their next boot.
- At boot, a guest helper installs LCU against the mounted app when the pinned
  pair changes, runs `lcu setup --agent auto`, and applies the VM's approval
  mode. A "Set up computer use" action reruns setup after a harness is
  installed.
- Export, import and transfer pass the mount again on restore and verify it.
- Changing the pinned version updates a VM at its next start.
- Remove app versions no VM references.
- VMs created before v4 keep their desktops; computer use requires a new VM.

### 6. Remove Luda and simplify

Remove the Luda recipe, status fields, repair action and documentation. New
VMs no longer offer "add a desktop"; keep only the minimal path existing VMs
need.

### 7. Upstream reports

- GTK 3: `PasteText` use-after-free (standalone reproduction available).
- MicroSandbox: late, unclear error for symlinked mount roots; `msb restore -v`
  cannot attach disk images from the CLI; our case on #1701/#1702.
- MicroSandbox: the checkpoint integrity check (`crates/image/lib/checkpoint/resolver.rs`) admits 1 MiB for a
  virtio-fs device state while the runtime's restore admits 8 MiB (patch `microsandbox-checkpoint-fs-state`); a
  bind mount's stat-virtualization identity map is filled by the guest agent's report and so is never set in a
  RAM-restored guest (host uid visible; Silo mounts with `uid=0,gid=0`); `inspect` has no runtime instance id.
- LCU/OpenAI `node_repl`: the default network-disabled sandbox blocks the native X11 connection (see section 9).

### 8. Verification

In the packaged Dev app with throwaway `e2e-*` VMs on macOS arm64 and the
Linux x86-64 test computer: fresh VM with no prompts and ready `doctor`;
Claude Code and Codex desktop tasks with independent file checks, approvals
on and off; export/import keeps the mount; GTK, Qt, Firefox, Chrome and
Electron expose trees; poller CPU cost; `df` on a cold cache; pinned-version
change. Record final sizes and add a `minor` changeset.

### 9. Live verification without a model (2026-10-02)

macOS arm64 (Silo main plus the fixes below, MicroSandbox 0.7.6 built from `runtime-inputs.json`,
bundled `msb` ad-hoc signed with `Entitlements.plist`, published v4 image
`ubuntu-24.04-v4-arm64`, ChatGPT 26.928.31416 downloaded by Silo's own downloader, LCU 0.8.1).
Real code paths through the opt-in live tests listed in
[Rust test support](SiloUI-RUST-TEST-SUPPORT.md#live-tests-and-temporary-directories); fixture
homes under `/tmp`, `e2e-*` sandboxes, live data, no packaged app. The Linux x86-64 computer was not used.

- Fresh VM: built in, desktop session running at start, computer use `installing`, then `ready`
  (about 25 s after Start); `lcu status --json` reports `tested`, `lcu doctor` passes (window list and
  screenshot), the folder is mounted `ro` and writes fail with EROFS. Accessibility: system default
  `toolkit-accessibility=true` and the poller run; no browser ships in the image, so Firefox,
  Chromium and Electron trees were not exercised.
- LCU's own MCP client (`adapters/client.mjs`), no model: GNOME Text Editor (GTK4) with `typeText` and
  `paste` does not crash, Save As through its dialog writes the expected bytes (checked by a separate guest
  command), per-key `pressKey` typing into Xfce Terminal writes its file. See the findings below.
- Approval: `apply_approval_with` `auto` adds exactly `default_tools_approval_mode = "approve"` (Codex) and
  `permissions.allow: ["mcp__lcu"]` (Claude Code, with Codex 0.160.0 and Claude Code 2.1.287 installed from npm);
  `ask` removes exactly those and nothing else. With nothing installed LCU's installer still creates `~/.codex`,
  so Codex is always registered and gets the approval line; Claude Code gets nothing until it is installed.
- Lifecycle (every step ends with the session running, computer use ready, the folder read-only and `lcu doctor`
  passing): restart, stop and start, checkpoint of the running VM, fork, in-place restore; export, import into a
  second home with its own folder (the imported VM takes the destination's `ask`).
- Boot loop (stale PulseAudio): 31 boots (one fresh VM, 10 restarts, 10 imports and 10 restarts of the imports, run twice) with 0 desktop failures: every one ended with the session running and computer use ready.
- Pre-v4: a VM from the v3 image has no mount, no desktop session, no helper and no computer-use state, and its
  restart, stop/start, checkpoint, fork and restore work.
- Numbers (cold home, one VM): the v4 image is a 396 MB archive and 1.30 GB in MicroSandbox's cache; a created VM
  takes about 33 MiB on the host at ready and 89 MiB after the desktop drive; the guest uses about 300 MiB of
  3.9 GiB with the desktop running (about 520 MiB after driving apps); creating the VM (image import) took 50 to 61 s
  and create to ready 61 to 76 s. The ChatGPT app download, verification and extraction took 120 s in the debug
  test profile.

Fixed by this verification (each with a test):

- Computer use never installed on a real runtime. The post-boot sync requires a runtime instance id, which
  MicroSandbox 0.7.6's `inspect` does not report (Silo's 0.7.6 patches dropped it), so the identity check always
  failed. The runtime's last-update time identifies the instance instead.
- Capturing a checkpoint of a running built-in VM failed with `checkpoint object exceeds 1048576 bytes`:
  MicroSandbox's integrity check admits 1 MiB for any device state while its restore admits 8 MiB for virtio-fs, and
  the folder's passthrough table was 1.18 MiB. `microsandbox-checkpoint-fs-state` applies the restore's limit.
- After a RAM restore (checkpoint fork or restore) the guest saw the host uid on the folder, LCU refused to start
  ("not in a location only root and this account can change") and Silo still reported `ready` from the previous
  boot's receipt. The folder is now mounted with `uid=0,gid=0`.

Findings left open:

- LCU's `js` tool cannot reach the X server in its default configuration. The original `node_repl` runs code in a
  `codex sandbox` with the network disabled, whose seccomp filter denies every `connect`, local sockets
  included (`Could not connect to X11 ... Operation not permitted`); `lcu doctor` does not go through it. A harness
  that supplies its own sandbox state (Codex) decides this itself; Claude Code supplies none. The drive test
  starts LCU with `CODEX_CLI_PATH` empty (kernel started directly), and reports the default configuration without
  asserting it. Needs an LCU decision (default sandbox state or the direct kernel) before real agent runs.
- `pressKey` sends X events to the selected window (`SendEvent`), which GTK4 ignores: per-key typing and shortcuts
  such as Ctrl+S do nothing in GNOME Text Editor, while `typeText`, `paste` and AX actions
  (`performSecondaryAction`) work. In GTK4 `typeText` also reports `SetCaretOffset NotSupported`, an error
  result although the text was inserted. GTK3 and VTE (Xfce Terminal) take `pressKey`.
- Silo's `computerUse.state` after a restart comes from the receipt on disk; only `lcu doctor` proves it
  (the lifecycle test checks both).

## Integration contract

Backend (Rust, guest scripts) and frontend implement this together.

- Host storage: `<app data>/chatgpt/` keeps `.lock`, downloads, staging and
  publication records; verified trees are published under
  `<app data>/chatgpt/published/<version>-<debarch>/`. VMs mount
  `published/` read-only at `/opt/silo/chatgpt`; the guest uses
  `/opt/silo/chatgpt/<pinned version>-<debarch>` passed by the host.
- Preparation is automatic and per computer. At app start, off the UI thread and
  at low priority (utility QoS on macOS, nice 10 on Linux), the app reads the
  status and, unless the pinned version is published, waits 10 s and runs the
  download in one background worker (never two at once: an in-process slot plus
  the storage lock). A retryable failure (network, firewall, disk space) is
  retried after 30 s, 1, 2, 5, 10, 30 min, then hourly, until it succeeds or the
  app quits; a failure retrying cannot fix (checksum mismatch, or HTTP 404/410 for the pinned
  version; a 401/403 refusal by a proxy or filter is retried) stops the worker until Retry. Offline or metered
  connections only mean later attempts: nothing waits for the download, and VM
  creation, start and restore never depend on it (the mount folder exists,
  possibly empty). When the app becomes ready the worker syncs running built-in
  VMs at once (`computer_use::app_ready`) and collects unused versions.
- Commands (Tauri): `chatgpt_app_status { computer? }` and
  `chatgpt_app_retry { computer? }`, where `computer` is a remote computer's
  host id (omitted: this computer; a sandbox target is rejected). Retry wakes a
  waiting worker or starts one, and returns the status at once. Removed:
  `chatgpt_app_accept_notice`, `chatgpt_app_prepare`, the consent file and the
  consent state. Events: `chatgpt-app-status` carries this computer's status
  object (`computer: null`); a remote computer has no events, the controller
  reads `chatgpt.status` (about every 3 s while it works, 15 s otherwise).
  Also `set_computer_use_approval { workspace, mode: "ask" | "auto" }`
  returning the desktop state, and the `desktop_action` action
  `setup-computer-use`, which reruns LCU setup for agents installed later.
- Bridge methods: `chatgpt.status` (read), `chatgpt.retry` (change, no VM id),
  `computer.approval`. Removed: `chatgpt.accept`, `chatgpt.prepare` and the
  placeholder `silo-remote:<host>:<nil-uuid>` routing. An owner on an older Silo
  answers `chatgpt.retry` as unsupported and `chatgpt.status` with its own
  consent-era states; the controller reads the owner's handshake capabilities
  (cached for a minute) and shows a computer without `chatgpt.retry` as `unknown`
  without asking its status, not as an error (`chatgpt_app_status` maps "unsupported" to `{"state":"unknown"}`,
  and the frontend maps any state it does not know to `unknown`).
- `desktop.builtIn: boolean` in a VM's saved/reported `desktop` object marks a VM
  created from a v4 image. Silo decides it; a written value is ignored.
- App status object, tagged by `state`: `idle` (waiting to download),
  `downloading { receivedBytes, totalBytes }`, `verifying`, `extracting`,
  `ready { path, version }`, `failed { reason, retryable }`. The controller
  adds `unknown` for a computer whose status it cannot read.
- Desktop state (`read_desktop_state`) gains an optional `computerUse` object
  for v4 VMs: `state` (`unavailable`, `preparing`, `installing`, `ready`,
  `failed`; `preparing` covers waiting, downloading and a failure Silo retries
  by itself, with the reason; `failed` is a final failure), `reason`, `compatibility` (`tested`,
  `untested`, `unknown`, from `lcu status --json`), `warning`, `approval`
  (`ask` or `auto`), `appVersion`, `runtimeVersion`, `lcuVersion`, `agents`.
  The legacy `lcu*` fields remain for VMs created before v4.
- Per-VM approval mode is stored in VM metadata, default `ask`, and applied
  with `lcu setup --approval`. Approval changes carry a monotonically increasing
  `revision`, stored in the policy file separately from receipt observations, and
  the computer's owner id (a random UUID kept in `computer-use/owner`). Every sync
  passes `--revision` and `--owner`; the guest helper orders revisions only within
  one owner (`approvalRevision`, `approvalOwner` in its status): it ignores a
  request older than the revision it applied for that owner, applies a request from
  a new owner whatever its revision (an imported or transferred VM takes the
  destination's choice even when the source clock was ahead), and resolves equal
  revisions with different modes in favour of `ask`. A sync runs in the VM's
  operation turn after confirming the runtime sandbox's `silo.machine-id` label and
  instance, and at app start Silo launches the sync for running built-in VMs whose
  guest lags the saved policy (a crash between saving and launching). `computerUse`
  reports `installing` with "Applying approval change…" while the guest lags the
  policy, and `failed` when applying it failed.
