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
- Silo never publishes OpenAI files. On each computer that hosts VMs, Silo
  downloads the official ChatGPT Linux `.deb` from OpenAI, after a one-time
  notice, and keeps one read-only copy shared by all VMs on that computer.
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
  (done: `guest/lcu-lock.json`, LCU 0.8.0, `/usr/local/share/silo/lcu/`).
- Accessibility: dconf `toolkit-accessibility=true` system default and an
  autostarted AT-SPI attribute poller for Chromium/Electron.
- GNOME Text Editor as the `text/plain` default instead of Mousepad.
- Build with bind mounts, never `COPY` of a package that is later deleted.

### 4. ChatGPT app on each computer

- Lock: app version, per-architecture SHA-256 and runtime version, plus the
  LCU version and SHA-256.
- One-time notice before the first download, linking OpenAI's terms.
- Download the exact pinned version from OpenAI's pool; verify SHA-256.
- Extract only `usr/lib/chatgpt` (macOS `tar`, Linux `dpkg-deb -x`); never run
  maintainer scripts. Refuse case collisions, setuid/setgid files, absolute or
  escaping paths and links leaving the tree. One immutable folder per version
  in a per-channel Silo data directory; publish atomically; delete the `.deb`.
- Pass canonical paths to MicroSandbox.
- Remote computers do this on the owning computer.

Done: lock (`lcuVersion` 0.8.0), notice, download, verification, extraction and
publication under `<app data>/chatgpt/published/`, with the three commands
registered, cached status reads and routing to the owning computer. See
[ChatGPT app](SiloUI-CHATGPT-APP.md).

### 5. VM integration

Done (see [built-in computer use](SiloUI-DESKTOP.md#built-in-computer-use)):
mount at creation and on every restore (verified), boot and app-ready sync,
approval modes, `setup-computer-use`, `computerUse` desktop state, garbage
collection of unused versions. Decisions: the guest step is pushed and started
by the host after every boot (`prepare_booted`) and when the app becomes ready
while VMs run, rather than by a guest boot hook, so the helper always matches
Silo; garbage collection runs at start and after a prepare, only while no VM
runs.

- New VMs are created with a stable per-computer folder mounted read-only at
  `/opt/silo/chatgpt`. That folder holds only verified, published version
  folders (staging, downloads and records live elsewhere) and is garbage
  collected, which keeps the first-statfs walk (#1701/#1702) small. It exists,
  possibly empty, before any VM starts, so a VM created before the one-time
  notice was accepted gains computer use later, and a pinned-version change
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

### 8. Verification

In the packaged Dev app with throwaway `e2e-*` VMs on macOS arm64 and the
Linux x86-64 test computer: fresh VM with no prompts and ready `doctor`;
Claude Code and Codex desktop tasks with independent file checks, approvals
on and off; export/import keeps the mount; GTK, Qt, Firefox, Chrome and
Electron expose trees; poller CPU cost; `df` on a cold cache; pinned-version
change. Record final sizes and add a `minor` changeset.

## Integration contract

Backend (Rust, guest scripts) and frontend implement this together.

- Host storage: `<app data>/chatgpt/` keeps `.lock`, consent, downloads,
  staging and publication records; verified trees are published under
  `<app data>/chatgpt/published/<version>-<debarch>/`. VMs mount
  `published/` read-only at `/opt/silo/chatgpt`; the guest uses
  `/opt/silo/chatgpt/<pinned version>-<debarch>` passed by the host.
- Commands (Tauri, local and routed to the owning computer like other VM
  operations): `chatgpt_app_status`, `chatgpt_app_accept_notice`,
  `chatgpt_app_prepare` (asynchronous; emits `chatgpt-app-status` with the
  status object), and `set_computer_use_approval { workspace, mode: "ask" |
  "auto" }` returning the desktop state. `desktop_action` gains the action
  `setup-computer-use`, which reruns LCU setup for agents installed later.
  As implemented, the three `chatgpt_app_*` commands take an optional
  `workspace` (no argument means this computer); for a remote VM they run on its
  owner (bridge methods `chatgpt.status`, `chatgpt.accept`, `chatgpt.prepare`,
  `computer.approval`; for a remote prepare the owner downloads and the
  controller polls it, emitting `chatgpt-app-status` itself).
- `desktop.builtIn: boolean` in a VM's saved/reported `desktop` object marks a VM
  created from a v4 image. Silo decides it; a written value is ignored.
- App status object, tagged by `state`: `notConsented`, `idle`,
  `downloading { receivedBytes, totalBytes }`, `verifying`, `extracting`,
  `ready { path, version }`, `failed { reason, retryable }`.
- Desktop state (`read_desktop_state`) gains an optional `computerUse` object
  for v4 VMs: `state` (`unavailable`, `needs-consent`, `preparing`,
  `installing`, `ready`, `failed`), `reason`, `compatibility` (`tested`,
  `untested`, `unknown`, from `lcu status --json`), `warning`, `approval`
  (`ask` or `auto`), `appVersion`, `runtimeVersion`, `lcuVersion`, `agents`.
  The legacy `lcu*` fields remain for VMs created before v4.
- Per-VM approval mode is stored in VM metadata, default `ask`, and applied
  with `lcu setup --approval`.
