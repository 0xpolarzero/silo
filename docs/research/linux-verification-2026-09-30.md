# Linux verification, 30 September 2026

## Scope and safety

Target: owner's x86-64 Ubuntu 26.04 machine at `10.77.77.2`, XFCE/X11
(`DISPLAY=:0.0`, runtime directory `/run/user/1000`). This is not Ubuntu 24.04
qualification or a release-readiness claim.

The initial installed package was `silo` 0.6.3, running as owner PID 9088 from
`/usr/bin/silo-ui`. Two existing sandboxes used legacy storage; no `msb` VM
process was running. Their inventory and disk metadata were recorded before
building. Disk content checksums use `SEEK_DATA`/`SEEK_HOLE`, include extent
offsets and logical size, and read through `O_NOATIME`.

Current Silo automatically migrates a legacy profile at launch
(`runtime_migration::start_if_pending`). The owner's instruction forbids changing
existing sandboxes. Package verification therefore uses isolated HOME/XDG roots
and a private D-Bus session on the logged-in X11 display. Normal-profile launch
and migration require a person and are not claimed as verified.

Evidence is local, ignored:
`app/SiloUI/src-tauri/target/verification/linux/`. Owner data and credentials
are not published. The remediation plan is unchanged.

## Source and build findings

- Initial source: `c663903e343282c537c8590902bdabda88d1c504`, copied with
  `git archive` into a dedicated Linux directory. Generated resources, caches,
  and dependencies were built there.
- `7d66cfba`: KVM API-query `ENODEV`/`ENXIO` now receives the same firmware
  guidance as device-open and VM-create failures. The new policy regression
  failed before the fix; all 13 dependency tests passed afterward on macOS.
  This is an injected error policy check, not a physical BIOS failure.
- `091b6d7e`: the actual cold Linux build failed reading `/usr/lib/LICENSE`
  with Ubuntu's Go 1.26 package. The packager now asks `dpkg-query` which package
  owns `GOROOT/bin/go` and includes its copyright notice. The regression failed
  before the fix; all six LFS packaging tests passed on Linux and macOS.
- Ubuntu 26.04 supplies `webkitgtk-webdriver` instead of the documented
  Ubuntu 24.04 `webkit2gtk-driver` package.

The [kernel KVM API documentation](https://docs.kernel.org/virt/kvm/api.html)
defines API version 12 and the empty VM descriptor returned by `KVM_CREATE_VM`.
Both operations succeeded on the host, and the descriptor was closed immediately.
[Debian copyright policy](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information)
requires package notices under `/usr/share/doc/PACKAGE/copyright`.
[Ubuntu's WebDriver package](https://packages.ubuntu.com/resolute/webkitgtk-webdriver)
records the renamed package used here.

## Verification results

The matrix combines the initial package (`091b6d7e`) and final package
(`54d38f16`) runs, using one isolated `e2e-linux-0930` VM. The final
package repeated upgrade guards, close/Cancel/Quit, second launch, editor
launch, help loading, AppImage transport/environment and KVM fault checks.

| Check | Result and scope | Evidence file(s) |
| --- | --- | --- |
| A-01 | Pass: `.deb` and AppImage built; installed package upgraded 0.6.3 to 0.9.0; private-profile production GUI and actual VM started. Ubuntu 26.04 only. | `install.log`, `package-smoke.json`, `build-fixed.exit` |
| A-02 | Pass: `dpkg -i` refused replacement while the test VM ran, removed its upgrade marker, and left the VM and sentinel intact; after stopping it, replacement succeeded and its data survived restart. | `upgrade-running-vm.log`, `upgrade-final-running-vm.log`, `upgrade-final-sentinel.json` |
| A-03 | Pass for package guards: a real bridge held open and a guest helper held at its executable entry point did not block replacement; both mapped the deleted predecessor binary and exited after release. Full two-computer workflow is outside this session. | `upgrade-final-helper-processes-{before,after}.json`, `upgrade-final-with-helpers.log` |
| F-03 | Pass: no StatusNotifierWatcher; close opened confirmation naming the test VM; Cancel preserved the running VM; Quit and stop closed the app and stopped it. | `no-tray.txt`, `no-tray-close-confirmation.png`, `no-tray-final-confirmation.png`, `sentinel-after-final-cancel.json` |
| F-09 | Pass: second launch exited 0, restored the minimized existing window, and left one main app process. | `second-launch-final.json`, `after-second-launch.json` |
| C-19 | Pass: real AppImage FUSE launch; helper paths resolved inside the current mount. | `appimage-final-environment-first.json`, `package-smoke.json` |
| G-12 | Pass: stable `silo-remote` link targeted the AppImage file; bridge handshake and editor SSH sentinel succeeded across different mount roots and application restarts, repeated on the final image. | `bridge-probe-final-{first,second}.json`, `transport-final-{first,second}.json` |
| G-24 | Pass for installed Ptyxis/Zed: child environment omitted the parent's AppImage mount and loader/plugin paths; both launched. | `appimage-final-environment-after-delay.json`, `appimage-final-environment-assertions.json` |
| G-06 | Pass for launch/lifetime: Zed opened `/workspace`; Microsoft VS Code 1.140.0 launched from its actual `.deb` desktop entry, remained alive beyond 10 seconds, and opened the Silo workspace window. VS Code Remote SSH completion needs a person because of an OS keyring dialog. | `appimage-zed-window.png`, `zed-e2e.log`, `code-final-processes.json`, `code-final-window-by-id.png` |
| G-07 | Pass for host defaults: `xdg-terminal-exec` opened XTerm; the copied default Zed desktop entry launched the installed editor. | `application-catalog.json`, `default-terminal.json`, `default-editor.json` |
| G-25 | Pass for installed terminal catalog and explicit Ptyxis selection; snap/Flatpak variants were not exercised; VS Code Remote SSH completion needs a person. | `application-catalog.json`, `appimage-ptyxis.json` |
| F-22 | Pass: actual API 12 and VM descriptor creation; packaged injected API-query ENODEV/ENXIO and create ENODEV showed firmware guidance; EBUSY showed competing-hypervisor guidance and blocked setup. Physical firmware disable remains untested. | `kvm.json`, `kvm-final-*.png`, `kvm-final-summary.log` |
| F-21 | Pass: with snap Firefox the default browser, Documentation opened the bundled help in a native WebKit window and loaded its contents. | `help-native.png`, `help-final-windows.json` |

## SFTP defect and upstream fix

Plain SFTP created a directory and file as `root:root` while the same SSH
connection ran commands as UID/GID 1001 (`silo`). Zed uploaded its HTML extension
into a root-owned directory with mode 775, then failed renaming the extension.
The pinned SDK handles SFTP through root-agent filesystem RPCs without the SSH
user. Evidence: `sftp-red.log`, `sftp-red-identity.log`, `zed-guest-identity.json`.

`7bf080c8` adds a SHA-256-pinned SDK patch that routes nonroot SFTP through the
existing guest exec stream as the effective SSH user. It uses the already
bundled OpenSSH subsystem. Explicit root sessions retain their original path;
a missing nonroot helper fails without fallback. The live account regression
now includes directory ownership and unprivileged rename. No external issue or
PR was sent.

The unchanged offline account acceptance then failed on `USER: parameter not
set` in an SSH command, after confirming UID/GID 1001 and the correct HOME.
`54d38f16` sets USER and LOGNAME from the effective guest user after client
environment requests. The full acceptance passed against that runtime: offline setup preflight and
refusal, account recovery, SSH/PTY identity, SFTP/SCP ownership and permission
failures, missing-helper refusal, explicit root SFTP, Git/LFS content and
ownership, and persistence across restart. Evidence: `account-final/live.log`
and `account-final.exit` (0).
Evidence: `account-before-login-fix/live.log` (failed predecessor run).

The [OpenSSH subsystem manual](https://man.openbsd.org/sftp-server) documents
its stdin/stdout protocol. The [pinned MicroSandbox SDK](https://github.com/superradcompany/microsandbox/blob/60d4dc8a436fb9365491567ec21d073e924e3c6d/sdk/rust/lib/sandbox/ssh.rs)
contains the original SFTP handler. [Ubuntu's maintained guest package](https://packages.ubuntu.com/noble/openssh-sftp-server)
is `1:9.6p1-3ubuntu13.19`, matching the AMD64 image manifest. The executable is
already a guest prerequisite, so this adds no daemon, network listener, or
package download. Kernel user permissions enforce file access instead of the
host translating every file operation. OpenSSH's [license terms](https://github.com/openssh/openssh-portable/blob/master/LICENCE)
permit reuse; the guest's existing package notices remain applicable.

## Commands and test boundaries

- Dedicated source copy: `git archive HEAD` streamed over SSH into
  `~/silo-verify/c663903e343282c537c8590902bdabda88d1c504`; source was refreshed
  after each local fix. The real configuration was copied privately from
  `app/SiloUI/github-build.local.json`, mode 600; no values were printed.
- Node 24.21.0, Rust 1.94.0, Ubuntu Go 1.26; installed the documented GTK,
  WebKit, cap-ng and packaging dependencies plus CLI GUI automation tools.
- `npm --prefix app/SiloUI ci`; `npm --prefix app/SiloUI run desktop:build --
  --bundles deb,appimage --ci`; `python3 scripts/package-debian-release.py`;
  `sudo apt-get install ./Silo_0.9.0_amd64.deb`; `sudo dpkg -i PACKAGE` for
  the guard/replacement checks. Build logs containing compiled configuration
  stayed private and were deleted during cleanup.
- Production IPC was driven by tauri-driver 2.0.6/WebKitWebDriver; native menu
  actions used AT-SPI; X11 window state used xdotool/xwininfo; screenshots used
  WebDriver and scrot. Every VM in these checks was a real KVM guest, not a
  frontend fixture. Guest secret input was a synthetic disabled grant.
- Typecheck passed; lint had zero errors and five existing warnings; 23 focused
  menu/queue frontend tests and three onboarding tests passed. Release tooling:
  53 passed, six intentionally skipped; six Go-notice tests, six Debian package
  tests and six desktop-build wrapper tests passed. New preflight: 15 passed; Linux
  runtime-manifest frontend tests: 13 passed.
  KVM policy: 13 native tests passed on macOS and Cargo formatting passed.
  These are focused checks, not a full Linux native suite or release readiness.

## Invalid attempts retained

A long temporary HOME exceeded the Unix socket path limit; the harness was
moved to a short task-owned `/tmp` path. OpenSSH reads its passwd home rather
than the harness HOME, so the isolated Zed profile needed explicit `-F` SSH
arguments, as [Zed's remote-development documentation](https://zed.dev/docs/remote-development)
supports. Neither required a production change.

The initial upgrade attempt had a stopped VM and is labelled accordingly.
The first KVM EBUSY shim incorrectly forwarded the argument-free API query and
returned EINVAL before reaching VM creation. That attempt is invalid; the
corrected shim independently returned API 12 and injected EBUSY only at
KVM_CREATE_VM. Some initial IPC requests omitted required arguments; their
responses are retained and do not count as passes. The first new runtime build
hit the exact patch-name allowlist; preflight was updated and its tests passed.
Reusing task-owned Cargo output exposed a cached build script with the old source
path; Cargo cleaned the SDK and filesystem packages before the retry. The
uncached full runtime build had already passed. Neither build failure is counted
as package verification.

## Needs a person

1. Normal-profile migration/listing: stop all local VMs, back up both existing
   disks and metadata, explicitly authorize migration, then launch `/usr/bin/silo-ui`.
   Confirm both sandboxes appear, open known files, and compare backups. This
   session deliberately leaves the normal-profile app closed to preserve data.
2. Resolve the desktop keyring prompt personally, then use a disposable profile
   with VS Code Remote SSH: choose Code in Settings, open an `e2e-*` VM workspace,
   finish its trusted connection prompts, edit/read a known file, and wait 30
   seconds. The installed Code launch and lifetime passed; the connection remained
   “Opening Remote…” behind the OS dialog. No unfamiliar security dialog was
   dismissed. Separately repeat terminal/editor launch with snap/Flatpak apps,
   which were not installed; record their versions and child environment.
3. Physical firmware case: use a spare machine, stop its VMs, disable VT-x/SVM
   in firmware, boot, confirm setup points to firmware settings, then re-enable
   it and retry. The injected errno tests do not prove that physical state.
4. Supported Ubuntu 24.04 and native Wayland: repeat these package and desktop
   checks there. The available logged-in desktop was XFCE/X11 on Ubuntu 26.04.

## Final package and cleanup

Final source: `54d38f16` (including `8c0c6813`'s concurrent CI/test-fixture fix).
The subsequent `c55c3c12` changes only a frontend test assertion; its Linux
runtime-manifest tests passed 13/13 and production build inputs are unchanged.
Exact installed executable: `/usr/bin/silo-ui`, 0.9.0; exact tested AppImage:
`~/silo-verify/c663903e343282c537c8590902bdabda88d1c504/app/SiloUI/src-tauri/target/release/bundle/appimage/Silo_0.9.0_amd64.AppImage`.

| Artifact | SHA-256 |
| --- | --- |
| Final Debian package | `ee3681e945ffcbd0cc96af1ab73b77cec8d7aae93bf77395302685766a5c5295` |
| Final AppImage | `9ca0dedaba001eee53128769371350f52724222bf72554bf6a4c9fe7b3d6d768` |
| Installed executable | `2b3c8ecbf5f4bcdbc61a7fd020fba10017983dddea5566193a62f93b813d9d8c` |
| Packaged patched MicroSandbox | `0e5f1837d604ceb9e267e2446c53c51e2f8f0605ac78e482348cc5156dd21ae5` |

The final package passed the direct SFTP/SCP identity, rename, root-path denial,
missing-helper failure, and explicit root-session checks (`sftp-final.json`).
Zed's actual HTML extension installed as `silo:silo` and contained its manifest
and WASM payload (`zed-final-extension.json`). The final no-tray Cancel preserved
the sentinel; Quit and stop stopped the VM. After the app exited, CLI Start
and a guarded package replacement independently identified the VM process,
refused replacement, left the marker absent, and preserved the sentinel. A
previous attempt raced asynchronous Quit and is retained as invalid; another
included editor transports and is labelled accordingly.

The final AppImage repeated bridge and persisted SSH transport after restart,
with the predecessor mount absent. Ptyxis and Zed launched with no parent mount
in their whitelisted environment (`appimage-final-environment-assertions.json`).
All four final KVM fault screens showed the expected guidance and disabled
Continue (`kvm-final-summary.log`, exit 0). Debian audit was empty.

Final owner inventory, disk inode/size/timestamps/allocation, extent counts and
sparse content digests matched the baseline exactly (`owner-preservation.json`,
`final-content.json`). The normal-profile app remains closed; no owner VM was
started, migrated, deleted, or edited. The test VM was deleted through Silo;
its inventory was empty. Both account-test VMs were stopped and their isolated
homes removed. No task process remained before filesystem cleanup.

All evidence was copied into the ignored local directory above and scanned
against the real build secret: zero matches. The Linux machine retains only the
installed Silo package and about 45 kB of selected evidence logs in
`~/silo-verify/evidence-20260930-linux/`. The build tree, private configuration,
temporary profiles, Node/Cargo/runtime/Go/npm output and caches were removed,
as were 382 newly created shared-cache entries. Pre-existing cache entries and
build toolchains were preserved. Go module-cache directories needed owner write
permission before removal; only task-owned directories were changed.

All 24 newly installed verification packages, including Code and its added
socat dependency, were purged. No Microsoft APT repository was added.
`x11-utils` was returned to its original automatic-install flag. APT upgraded
the pre-existing `xserver-common` and `xserver-xorg-legacy` packages while
installing Xvfb; those updates remain. No autoremove or desktop restart ran.
Cleanup evidence: `cleanup-final.json`, `cache-cleanup.json`,
`temporary-tools-remove.log`, `task-process-cleanup-audit.json`.

Four fixes and this evidence record are committed locally. No push, version
bump, tag, changeset consumption, plan edit, or publication occurred.
