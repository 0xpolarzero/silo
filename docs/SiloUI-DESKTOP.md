# Optional Linux desktop

Silo can install an Xfce desktop into the same Ubuntu 24.04 sandbox used for
terminal work. Creation opt-in and later installation use the same recipe.
The desktop is optional; no removal operation is provided.

## Lifecycle

`Start desktop with sandbox` defaults on. A managed VM boot starts the installed
desktop when that setting is enabled. Switching it off leaves a running desktop
alone. Switching it on starts the desktop immediately when the VM is running.
Manual mode leaves the desktop stopped after VM boot until explicitly started.
Closing a viewer disconnects only the view. Desktop stop closes graphical
applications, preserving independent terminal jobs; VM stop ends both.
An explicit desktop stop in automatic mode lasts for the current boot.

The guest helper is `/usr/local/bin/silo-desktop`, with `status`, `start`, `stop`,
`restart`, `boot`, and `autostart true|false` operations. Management requires
root. Its `connection` operation returns sensitive guest viewer credentials and
must never be logged or exposed in ordinary UI. Guest metadata lives in
`/var/lib/silo-desktop`; transient process identity is tied to Linux boot ID
and process start time. The helper allows three startup attempts, then leaves a
failed state for explicit recovery.

## Applications and external tools

VMs use `silo`, with home `/home/silo`, for terminal, SSH, editor and desktop
work, with passwordless sudo for administration. Installing the desktop later
reuses that account and preserves existing workspace files. Older VMs require
[explicit migration](SiloUI-WORKING-ACCOUNT-MIGRATION.md) or recreation first.
Adding a desktop never migrates accounts or file ownership.

Run graphical programs as the VM's desktop user with `DISPLAY=:1` and
`XAUTHORITY` pointing to `.Xauthority` in that user's home. The session provides
D-Bus and an accessibility bus. Root-owned files retain ordinary Linux access
rules, including on new VMs when files were deliberately created with sudo.
Conflicting pre-existing VNC configuration is reported before installation,
rather than overwritten. See [working accounts](SiloUI-WORKING-ACCOUNT.md).

Adding a desktop installs [Luda tools and skill](SiloUI-LUDA.md) for all supported
agent profiles under `silo`, including agents installed later. Silo does not
install or authenticate the agents themselves. Existing desktops offer explicit
agent-tool setup and repair in their viewer. Tools running in a remote
SSH project must execute inside the guest and target this display; selecting
an SSH project does not redirect a macOS-only plugin. Human and automated
input share the ordinary Linux session without Silo arbitrating control.

The initial recipe includes a terminal, file manager, text editor and fonts.
Users install additional applications, including their preferred browser.

## Recipe and sources

### Historical account decision audit, 2026-09-21

The single-account requirement above supersedes this audit’s compatibility
recommendation. The technical reasons for using a normal account still apply.

The separate desktop account is a compatibility compromise with the existing
root-based terminal/SSH workflow, not a requirement to prevent data corruption.
The original research recommends a normal account for application compatibility;
the implementation plan also requires preserving existing identities, credentials
and ownership. Neither records a same-account corruption reproduction.

Concrete upstream constraints:

- [Chromium's Linux startup code](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/zygote_host/zygote_host_impl_linux.cc)
  exits when running as root without `--no-sandbox`. A root desktop therefore
  requires a browser sandbox bypass; VM isolation does not replace browser
  process isolation inside the guest.
- [VS Code's Linux launcher](https://raw.githubusercontent.com/microsoft/vscode/main/resources/linux/bin/code.sh)
  rejects an ordinary root launch, checks for specific override arguments, and
  instructs users to provide `--no-sandbox` and an alternate user data directory.
- [KasmVNC 1.5.0's launcher](https://raw.githubusercontent.com/kasmtech/KasmVNC/v1.5.0/unix/vncserver)
  uses home-relative `.vnc`, `.kasmpasswd`, and default `.Xauthority` paths.
  Reusing an account requires respecting existing files at those paths. Its
  environment check does not itself demand a separate non-root account.

The installer already runs as root and modifies system packages for both
accounts. A separate session account cannot isolate package conflicts or an
interrupted apt operation. It does avoid writing desktop configuration into
the existing home. Same-account installation does not inherently require
changing workspace ownership or moving existing data. A naive port of this
recipe would overwrite existing `.vnc/kasmvnc.yaml` and `.vnc/xstartup`; those
specific collisions need preflight checks or dedicated paths, not necessarily
a separate UID. Session/display conflicts likewise need explicit handling.

The current split has real costs: desktop processes retain ordinary non-root
access rules for root-owned project files and use a different home for tools,
Git settings and credentials. Passwordless sudo does not automatically make
ordinary desktop file operations privileged. Conversely, unrestricted sudo
means this is not a security boundary against a malicious desktop process.
Desktop shutdown uses process groups, so independent terminal-job survival
does not intrinsically require a second UID.

Engineering recommendation: retain the non-root desktop for existing root-based
VMs; do not replace it with an all-root desktop as a simplification. For a
unified workflow, use one normal working account for terminal, SSH and desktop,
with root for administration. Existing VMs need an explicit migration of the
working environment, separate from installing desktop packages; do not silently
change ownership or move credentials during desktop installation.

This audit inspected repository code/history and upstream source. It did not
run a root-desktop A/B test or establish browser sandbox support on the pinned
guest runtime. Existing verification below explicitly excludes browser workloads.

- Xfce packages come from Ubuntu 24.04 repositories, using a minimal package set.
- KasmVNC is pinned to 1.5.0, with separate SHA-256-verified Noble packages for
  ARM64 and AMD64. [Release assets](https://github.com/kasmtech/KasmVNC/releases/expanded_assets/v1.5.0).
- Configuration follows the [versioned defaults](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/unix/kasmvnc_defaults.yaml).
- The viewer opens with `resize=scale`, selecting client-side local scaling while
  the guest keeps its fixed 1440×900 display (`allow_resize: false`). Window
  resizing must not change the guest screen or pointer coordinate space. See
  [KasmVNC local-scaling configuration](https://github.com/kasmtech/KasmVNC/discussions/249).
  The URL contains no authentication material; native cookies authenticate the
  local proxy.
- Noninteractive authentication follows the [versioned password tool](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/unix/kasmvncpasswd/kasmvncpasswd.c).

Guest HTTP authentication is enabled. Silo's viewer transport owns loopback
forwarding and remote SSH tunneling. Do not manually publish guest port 6901
to an untrusted network. The guest password is generated randomly, stored in
root-only metadata, and passed to KasmVNC through stdin rather than arguments.
The installed package inventory is recorded in `/var/lib/silo-desktop/packages.txt`.
Package licenses remain available through Ubuntu's `/usr/share/doc` inventory;
KasmVNC source and license notices are available in the linked release project.

Installation rejects unsupported OS/architectures, insufficient free disk,
unmanaged conflicting VNC installations and an unrelated pre-existing desktop
account. Downloads are verified before installation. Interrupted package
operations are not transactional; the stage journal supports investigation
and retry. Existing installed desktops are not silently upgraded on boot.

## Verification, 2026-09-18

A disposable ARM64 VM on macOS, using the bundled MicroSandbox engine in an
isolated runtime home, successfully installed Xfce and KasmVNC, rendered the
1440×900 desktop, launched Mousepad, typed into it through independently
installed xdotool, and exposed X.Org display `:1`.
Unauthenticated HTTP returned 401; authenticated HTTP returned 200.
Manual/automatic preference changes and start/stop passed, including an
independent terminal job surviving desktop shutdown. A partial installation
retry succeeded without replacing the desktop account. A second pristine VM
installed the complete corrected recipe without manual fixes. With the patched
bundled runtime, automatic startup ran after VM boot, explicit stop reset on
automatic reboot, and manual mode remained stopped after reboot.

The rebuilt isolated macOS bundle at
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Desktop Verification.app`
rendered the live guest desktop through the authenticated native viewer.
Native input displayed ASCII text and `café` in Mousepad. Independent guest
XInput observation confirmed pointer button and keyboard events from KasmVNC.
Closing and reopening the viewer preserved Mousepad in the same desktop session.
The application's guarded Quit exited successfully, and subsequent read-only
runtime checks confirmed both disposable proof VMs were stopped.

The CUA typing tool did not emit the requested CJK text, so that attempt does
not establish either working or broken CJK guest input. Full international
input, IME behavior, and clipboard coverage remain unverified.

A warm stop/start comparison with no viewer reported a 126,096 KiB decrease in
guest MemAvailable (about 123 MiB), and 238,819 KiB summed proportional memory
for desktop-user processes (about 233 MiB). These are different measurements,
not interchangeable budgets. They do not establish host memory cost, a cold
baseline, browser workload or active streaming cost.

The guest lifecycle test command is:

```sh
python3 -m unittest discover -s app/SiloUI/scripts -p test_desktop_service.py
```

Ten deterministic tests cover startup preference behavior, stale process
identity, session health reporting, credential-free status and bounded logs
that refuse symlinks. Live evidence is kept under ignored `app/SiloUI/src-tauri/target/verification/desktop/`.
These results do not establish AMD64/Linux or remote-owner compatibility.
The native viewer result applies to the inspected macOS verification bundle,
not an installed distribution or release readiness.

### Final application checks

The final isolated macOS ARM64 bundle passed windowed/fullscreen layout, toolbar
visibility, desktop stop confirmation, stop/start without stopping the VM, and
returning from fullscreen. Native layout uses the measured difference between
WKWebView's native frame and its CSS viewport; local scaling keeps the guest
at 1440×900. Temporary diagnostic logging was removed before the final build.

Commands and results:

- `npm --prefix app/SiloUI run typecheck`: passed.
- `npm --prefix app/SiloUI run lint`: passed.
- `npm --prefix app/SiloUI test`: 95 files, 855 tests passed.
- `cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --quiet`:
  437 passed, 11 opt-in tests ignored. Tests include actual loopback HTTP,
  WebSocket forwarding/disconnect, Unix-socket port reuse, subprocess lifecycle
  cleanup, native geometry, backup persistence and capability isolation.
- `python3 -m unittest discover -s app/SiloUI/scripts -p test_desktop_service.py`:
  10 passed.
- `npm --prefix app/SiloUI run test:release`: 34 passed against disposable
  release fixtures; no release was published.
- `npm --prefix app/SiloUI run desktop:build:debug -- --config
  '{"identifier":"org.silo.desktop-verification","productName":"Silo Desktop Verification"}'`:
  built successfully. This separate application identity used only disposable
  VM data; the user's normal Silo application data was not used.

These results do not establish live Linux/KVM, AMD64, remote-owner, browser
workload or complete IME compatibility. The remote implementation and AMD64
recipe require those environment-specific acceptance runs before claiming
cross-platform release readiness. Installed desktops are not automatically
upgraded by this first recipe.

## Native viewer input investigation, 2026-09-22

The macOS viewer has a concrete clipboard compatibility gap. This investigation
used repository source, pinned upstream source and an isolated WKWebView probe.
It did not launch or inspect a packaged Silo bundle, connect to a guest, read the
host clipboard, or reproduce the reported typing/Enter delays in a live session.
No production behavior changed.

### Confirmed mechanism

1. `desktop_viewer.rs` creates a nonpersistent child webview with the default
   browser user agent and navigates to `/?resize=scale`. It does not explicitly
   disable seamless clipboard. The installed Wry 0.55.1 implementation only
   overrides WKWebView's user agent when the caller supplies one.
2. Silo pins KasmVNC 1.5.0. Its [release submodule metadata](https://api.github.com/repos/kasmtech/KasmVNC/contents/kasmweb?ref=v1.5.0)
   pins the browser client to `475ecfa5356579ef222983c7ce4619a7576a3bce`.
   That client's [browser detection](https://github.com/kasmtech/noVNC/blob/475ecfa5356579ef222983c7ce4619a7576a3bce/core/util/browser.js)
   recognizes Safari by the literal `Safari` token. Its [settings and connection code](https://github.com/kasmtech/noVNC/blob/475ecfa5356579ef222983c7ce4619a7576a3bce/app/ui.js)
   disable seamless clipboard for recognized Safari; both safeguards depend on
   that token.
3. An isolated nonpersistent WKWebView on this host returned
   `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)`.
   This fails both Safari safeguards. Executing the exact upstream detection,
   default-setting, connection-safeguard and clipboard-check functions with this
   measured user agent enabled seamless clipboard and called the mocked clipboard
   reader once. A Safari-token control and an explicit seamless-off control each
   produced zero clipboard reads.
4. The pinned client's [input code](https://github.com/kasmtech/noVNC/blob/475ecfa5356579ef222983c7ce4619a7576a3bce/core/rfb.js)
   checks the clipboard on canvas mousedown when its resend flag is set. Window
   focus/blur and canvas focus set that flag. [WebKit documents](https://webkit.org/blog/10855/async-clipboard-api/)
   that programmatic clipboard reads without explicit paste intent or same-origin
   clipboard content show a native macOS Paste context menu.

This establishes a path from ordinary clicks to a native Paste prompt. Kasm's
[earlier upstream fix](https://github.com/kasmtech/noVNC/pull/110) explicitly
disabled seamless clipboard for Safari and Firefox to prevent this experience.
The embedded WKWebView identity escapes that existing protection.

The matching upstream report is [KasmVNC #219](https://github.com/kasmtech/KasmVNC/issues/219):
ordinary left and right clicks open a menu containing only Paste; dismissing it
helps until the pointer leaves and re-enters the viewer. In the linked fix,
the maintainer explicitly identifies clipboard reads during clicks as the trigger.
This is an input correctness defect, not evidence of insufficient VM resources
or a frame-rate tuning problem.

Other upstream macOS input reports have different triggers:
[KasmVNC #341](https://github.com/kasmtech/KasmVNC/issues/341) reports broken mouse
and keyboard input after the macOS screenshot shortcut, on Chrome with KasmVNC
1.3.4; [#236](https://github.com/kasmtech/KasmVNC/issues/236) reports an Alt-key
translation failure on Chrome with KasmVNC 1.2.0. Neither establishes the cause
of this user's delayed ordinary typing/Enter in Silo's WebKit viewer.

### Coverage and next action

The [later published-app test report](SiloUI-LUDA-AGENT-TESTS.md#silo-user-flow-coverage)
already records repeated native Paste prompts and no clean keyboard acceptance
result. Earlier limited ASCII/Unicode success above does not establish reliable
click, focus, clipboard or keyboard behavior across sessions. The frontend viewer
tests mock native attachment and do not exercise guest input.

The selection and delayed text/Enter symptoms still need a live event trace;
this investigation does not attribute them to the clipboard defect. Packaged-app
acceptance must cover click, drag/release, text, Enter, explicit paste and focus
transitions before claiming those symptoms are resolved.

Ignored evidence is in `app/SiloUI/src-tauri/target/verification/desktop-input/`:
`probe.swift`, `webkit-probe.json`, pinned source files, `reproduce.mjs` and
`reproduction.json`. The sandboxed Swift attempt timed out because WebKit services
could not start; the permitted unsandboxed rerun passed. Commands that passed:

```sh
swift -module-cache-path /private/tmp/silo-desktop-input-swift-cache app/SiloUI/src-tauri/target/verification/desktop-input/probe.swift
node app/SiloUI/src-tauri/target/verification/desktop-input/reproduce.mjs
```

### Clipboard fix

The native viewer now explicitly opens KasmVNC with
`resize=scale&clipboard_seamless=false` on initial attachment and reconnect,
for both local and remote desktops. This applies the supported client setting
without relying on browser identification or updating existing guest packages.
KasmVNC's [settings parser](https://github.com/kasmtech/noVNC/blob/475ecfa5356579ef222983c7ce4619a7576a3bce/app/ui.js)
gives URL settings precedence over saved preferences. Manual clipboard upload
and download remain enabled; users transfer text through the viewer's Clipboard
panel, as described in [upstream's clipboard documentation](https://kasmweb.com/kasmvnc/docs/latest/clientside.html#clipboard-seamless).

Verification uses the real production URL and the pinned client's settings
parser, checkbox conversion, clipboard reader and manual-send functions, with
mocked DOM controls, clipboard and transport. Before the fix, three simulated
focus changes caused three clipboard reads. After the fix, there were zero
reads with either clean settings or a previously saved `clipboard_seamless=true`;
manual transfer still delivered the supplied Unicode text. Evidence and the
one-command reproducer are in `target/verification/desktop-input/verify-url.mjs`,
`client-red.log` and `url-verification.json` under `app/SiloUI/src-tauri/`.

The native regression asserts the navigation contract for fresh loopback origins,
including preserved scaling and manual clipboard defaults. It failed before the
fix; all four viewer tests passed afterward with:

```sh
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --target-dir app/SiloUI/src-tauri/target/local-signing --release --offline --quiet desktop_viewer::
node app/SiloUI/src-tauri/target/verification/desktop-input/verify-url.mjs
```

These checks do not replace packaged-app or live guest input acceptance; no
bundle was launched for this change. The change takes effect when the updated
application opens or reconnects a desktop viewer.
