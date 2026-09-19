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

The desktop runs as `silo-desktop`, with home `/home/silo-desktop` and
passwordless sudo. It does not change ownership of existing workspace files.
Run graphical programs as this user with `DISPLAY=:1` and
`XAUTHORITY=/home/silo-desktop/.Xauthority`. The session provides D-Bus and an
accessibility bus. Existing root-owned files retain their normal Linux access
rules; users can deliberately change permissions or copy files as appropriate.

Silo does not install agent harnesses, computer-use plugins, or MCP servers.
Users configure compatible Linux tools themselves. Tools running in a remote
SSH project must execute inside the guest and target this display; selecting
an SSH project does not redirect a macOS-only plugin. Human and automated
input share the ordinary Linux session without Silo arbitrating control.

The initial recipe includes a terminal, file manager, text editor and fonts.
Users install additional applications, including their preferred browser.

## Recipe and sources

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
