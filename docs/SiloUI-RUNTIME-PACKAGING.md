# SiloUI runtime packaging

Status: MicroSandbox 0.7.4 runtime inputs and eleven patches are pinned; the qualification evidence in this document was collected on the 0.7.2 runtime and has not been repeated on 0.7.4 (see [MicroSandbox 0.7.4 upgrade](#microsandbox-074-upgrade)). The optimized macOS qualification bundle passed disposable migration, checkpoint, fork, restore, restart, and authorized live GitHub policy checks. On Linux ARM64, the final AppImage passed native WebKit smoke, packaged-tool integrity, and dependency checks; the authentic predecessor passed migration, checkpoint/fork/restore, RAM/process replay, same-home lineage exports, cold-cache import/Start with the original source cache absent, relaunch persistence, and saved/native/physical capacity checks. These tests ran in an Ubuntu 24.04 ARM64 Lima guest with nested KVM on Apple Silicon, not bare-metal Linux ARM64. On Linux x86-64, the runtime-7 package passed authentic migration and the same-home export matrix; a separate production fresh-home import/Start passed with source cache paths absent. The x86 desktop package also passed unsaved Mousepad checkpoint/fork/source-restore and stale-X11 recovery. The positive live remote-viewer check passed on the final x86 AppImage SHA-256 `8079943262a6a70e007403aa3900d1fd857080d63a04ea8dc4fb700dc5c7d8b2`, controller executable SHA-256 `96ffb0bad56f0e655d2072a7d9ad7bf987c83961292b5c62d84f5d437d671465`. Pinned-key SSH authenticated and exited 0; the running remote viewer connected, while opening a stopped fork left it stopped. Evidence is in `app/SiloUI/src-tauri/target/verification/x86-final-desktop-20260927/remote-final/`. The later user-authorized x86 runtime-8 AppImage passed payload, manifest, tool-version, protocol-probe, and dependency verification, as well as live port-control proof. Its package SHA-256 is `58a0516b396632390b9637966219ff732b577810fcf18483dcc9cbb1409d804a`; detailed hashes and evidence are in [Linux verification](SiloUI-LINUX-VERIFICATION.md). The native GTK destination chooser and source-only archive export passed; see [Linux verification](SiloUI-LINUX-VERIFICATION.md). Release signing and distribution are publication steps outside this implementation qualification.

## Qualification evidence

On 2026-09-25, `npm --prefix app/SiloUI run runtime:prepare` compiled the pinned release CLI and passed every executable capability and Silo protocol probe, then staged the aarch64 macOS runtime, Git, and guest. The exact GitHub owner resolver source in the network patch matches the tree that passed the upstream 574-test network suite; focused resolver tests passed 4/4 and the CLI probe parser test passed 1/1. The packaged `msb` returned `msb 0.7.2`, and each of its five Silo protocol probes returned `1`. The full native suite passed 492 tests, with 12 ignored and none failing; release-tool tests under Node 24.11.1 passed 36, failed 0, with 5 skipped. A command-lock lifecycle race was reproduced in the storage-history test and fixed; four focused lock tests, the history regression, and the final full suite passed. The migration completion persistence fix then passed its focused module 7/7. The final optimized bundle at `/private/tmp/silo-072-isolated-bundle-target/release/bundle/macos/Silo.app` compiled migration and GitHub restore-policy changes with identifier `org.silo.preview.migration-qualification`; the local bundle verifier and `codesign --verify --deep --strict` passed. The bundled CLI version and all five protocol probes verified; features were `net,ssh,embed-binaries`. Its `silo-ui`, `msb`, and `libkrunfw` SHA-256 values and preserved build log are recorded in `app/SiloUI/src-tauri/target/verification/packaged-macos-checkpoint-fork-restore-20260925/final-combined-package.txt` (untracked local evidence). The 1.8 GiB isolated build target was removed after verification; the small evidence remains.

The isolated bundle's first launch exposed missing Tauri ACL entries for the new migration and checkpoint commands. `build.rs` and `capabilities/preview.json` now explicitly register the seven commands; `command_permissions_tests.rs` checks the generated command registry and main-window allowlist. The focused regression passed. A separate migration regression verifies staged-inspection failures retain a static sanitized cause, validated sandbox name, and numeric exit code without raw command output, paths, or credentials; all six migration tests passed.

The qualification UI exercised interrupted migration, Retry, Show logs, acknowledgment-gated Continue, and restart using only disposable app data. The deliberately invalid fixture remained unavailable after failure; Continue switched to a clean runtime generation and restarted. Original fixture `machines.json` and workspace hashes matched the pre-action manifest at `app/SiloUI/src-tauri/target/verification/migration-qualification-source-before-continue.sha256.json`. The failure UI run preceded the sanitized-cause fix; its visible log was generic. The corrected cause has focused native regression coverage, but the updated failure screen was not separately rechecked visually.

The qualification app migrated a copied stopped `migration-proof` sandbox, displayed it Stopped in the normal overview, and restarted without the migration gate. The journal durably recorded 1/1 converted; after creating a fork, it stayed complete across Quit/relaunch although converted metadata now held 2 VMs. We explicitly started the source, created a full/manual checkpoint, forked it into a stopped sibling, and explicitly started that fork. Distinct active writable layers and source-only/fork-only files demonstrated storage independence. Restore created a full “Before restore” recovery checkpoint; after app restart the source remained stopped pending explicit Start, then restored the checkpoint sentinel and removed both post-checkpoint files. The fork remained stopped. The original copied workspace hash was `f4bc56a62aabe5430dffaf3cb3536c345b80e20df465d053db05fe44d0b87e7e`. Exact UUIDs, checkpoint records, file hashes, writable-layer paths, and results are in `app/SiloUI/src-tauri/target/verification/packaged-macos-checkpoint-fork-restore-20260925/RESULTS.txt` (untracked local evidence).

The installed `/Applications/Silo.app` was restored at its exact executable path. Its normal overview showed `dev` and `hermes` Stopped; no production VM was started. The qualification app was absent and both qualification guests were Stopped before test artifacts were pruned. The original source fixture remains at `/private/tmp/silo-uiq/runtime`; the isolated qualification app-data and the final bundle were removed after hashes and small evidence were preserved. No user app data was changed.

The GitHub restore-target selection passed a focused regression and synthetic signed-runtime full-snapshot test (1/1 each). An authorized live GitHub test passed 1/1 in 117.47 seconds using the connected account and a disposable repository. It captured a full checkpoint while the source had write access, assigned the fork the current read-only host profile before its first execution, then verified clone/read success and immediate issue-mutation/Git-push denial. The real host token did not enter the guest. Test issue, branches, temporary VMs, and child tokens were cleaned up. No unrelated repository was accessed.

Linux x86-64 acceptance ran in a disposable Ubuntu 24.04 container hosted by Ubuntu 26, on an ext4 task disk. KVM API 12 and actual `KVM_CREATE_VM` succeeded, and the ordinary AppImage smoke passed 10/10. The authentic predecessor fixture uses the installed Silo 0.6.3 / MicroSandbox 0.6.17 and Ubuntu 24.04 v2 guest. A HEAD-patched 0.6.17 host utility provisioned the guest's `silo` account; verification confirmed UID 1001, the SFTP server, preserved marker `legacy-source-before-checkpoint` with ownership 1001:1001, and a stopped VM carrying `silo.working-account=1`. The backup snapshot remains verifiable. Its first apt attempt failed because the original disposable VM had networking disabled; that VM alone was reconstructed from the verified 0.6 snapshot with the original workspace and supported `public` network profile, then the existing backup was resumed. Packaged Silo conversion passed 1/1. The production UI displayed it stopped; explicit Start, full checkpoint, stopped-fork/explicit-start, RAM-marker and guest-process survival, source/fork workspace independence, recovery-point creation, and stopped pending-restore across app restart passed. A pending-source recovery-fork bug was fixed and passed a real UI retry. The latest expanded run passed 11 lifecycle assertions through source disk/RAM/process rollback after restart. Linux qualification also fixed the short lifecycle-lock wait, completed-history re-quarantine, missing 4 GiB defaults and 0.7 config canonicalization, temporary snapshot-ancestry retention, snapshot-index reads truncated above 32 KiB, multi-member archive-head selection, snapshot selectors constrained by VM-name limits, and the disk-only snapshot-start flag. The production UI exported a 922,837,009-byte v3 archive; native head/integrity verification passed. The imported VM started explicitly and its workspace marker matched byte-for-byte, with source/fork post-checkpoint files absent. A repeated export originally failed because Silo created each capture in a fresh group without persisting lineage. Silo now stores the lineage group on each managed VM, carries it through import/fork/restore/relaunch, and captures backups in that group. Focused regressions passed; the final ARM64 same-home matrix exported source, imported VM, and fork twice each after one existing import. The ordinary 10/10 x86 AppImage smoke passed on package SHA-256 `f3ed57daaeccc7237780f4b78399222e5805413367671194c9a7d714fd811a6c`; the authentic predecessor migration and seven-export same-home matrix passed separately on runtime-7 package SHA-256 `f741e941c7d215835282ab7159b7ae32cef50bfba51311aceb5593ed9a4b1189`. A separate x86 fresh-home import/Start passed with the original source cache absent and destination VMDK paths verified, as recorded in the Linux acceptance research note. The native GTK folder chooser passed and wrote source-only archive SHA-256 `73791219b0b3fe2ecfed8a323480b96a4fa9c548d0692c214b680abdb432b2e1`. Do not infer that these checks all used one package. The later x86 Mousepad session proof passed on the desktop package recorded in the research note. The earlier x86 controller attempt returned zero raw SSH bytes after 25 seconds, before the final raw-stream flush fix. The positive live remote viewer subsequently passed on AppImage SHA-256 `8079943262a6a70e007403aa3900d1fd857080d63a04ea8dc4fb700dc5c7d8b2`: pinned-key SSH authenticated and exited 0, the running source viewer connected, and opening a stopped fork left it stopped. Compact evidence is in `app/SiloUI/src-tauri/target/verification/x86-final-desktop-20260927/remote-final/`. The final x86 runtime-8 AppImage and live port-control proof passed; see the qualification record below. A backup-history startup fix passed its focused regression. The final rebuilt AppImage, SHA-256 `f3ed57daaeccc7237780f4b78399222e5805413367671194c9a7d714fd811a6c` (211,974,648 bytes), passed the 10/10 ordinary smoke at `/work/evidence/appimage-smoke-final-42b4-extract`. A separate current-0.7.2 utility apply on a disposable v3 guest passed account, workspace, descriptor-path and snapshot verification; the focused 11-test suite covers interruption/resume, but the successful live run did not induce a second interruption. Its compact evidence is `app/SiloUI/src-tauri/target/verification/linux-account-migration-072-20260925.txt` (untracked local evidence). An earlier synthetic 0.7.2 VM staged in the old runtime directory is not predecessor compatibility evidence.

Linux ARM64 qualification completed on a disposable Ubuntu 24.04.4 ARM64 Lima VM on Apple Silicon with nested KVM. The authentic 0.6.17 Ubuntu 24.04 v2 guest migrated through the production UI and passed the 14-assertion checkpoint/fork/restore lifecycle. The final local AppImage is SHA-256 `14c4215d141c49399f44817a28edd0946d05e0a12c5fa86b468c831e8272c448`; its six managed ELF payloads in `usr/libexec/silo/tools` match the prepared hashes. A live AppImage WebKit smoke confirmed its `APPDIR` path, passed dependency preflight with all three tool rows checked, and passed native route, secret-form, autostart, and relaunch-persistence checks. The final local DEB (SHA-256 `127479a7939220c314c12ab83798e03507b2a1854dbf7213c97cb8f18a8694d6`) was installed only in the disposable guest. Its production IPC lineage matrix resumed an existing same-home import and fork without creating another import, exported source/import/fork twice each, and verified persisted groups across relaunch. All three had matching saved/native/raw-image capacity of 1 CPU, 1024 MiB RAM, and 4096 MiB. The imported VM's exact deny-all network profile remains intact and is accepted by backup validation; unrelated custom rules remain rejected. A separate cold-cache proof created one valid source archive through production IPC, imported it into a fresh app-data/HOME, then started the imported VM after both the original source alias and its canonical backing storage were absent. Root and workspace marker contents matched after Start. The destination held its own VMDK base image, raw managed root, and qcow2 overlay, with 10 GiB virtual root capacity. Archive SHA-256: `cbc27a90525091d2cd94fef88fd21da69e29d9ff59af59377c20666aa3637d12`. Compact cold-cache/package evidence is `app/SiloUI/src-tauri/target/verification/arm64-cold-cache-qualification-2026-09-26/` (untracked local evidence); lifecycle and lineage evidence remains in `app/SiloUI/src-tauri/target/verification/arm64-final-qualification-2026-09-26/` (untracked local evidence). These results cover an ARM64 Linux guest with nested KVM, not bare-metal ARM64 Linux. The native GTK chooser passed for a source-only archive export; see [Linux verification](SiloUI-LINUX-VERIFICATION.md). Unsaved graphical editor-buffer survival passed in the later x86 Mousepad checkpoint/fork/source-restore run recorded in the Linux acceptance research note. Release signing and distribution are publication steps outside this implementation qualification.

## Pinned runtime

Silo now pins the official [MicroSandbox v0.7.4 release](https://github.com/superradcompany/microsandbox/releases/tag/v0.7.4), source commit [`e36ffc0a58b48d70e0e4d66d75f1596994e3865a`](https://github.com/superradcompany/microsandbox/tree/e36ffc0a58b48d70e0e4d66d75f1596994e3865a). The pinned source archive is the commit archive `https://codeload.github.com/superradcompany/microsandbox/tar.gz/e36ffc0a58b48d70e0e4d66d75f1596994e3865a`; its SHA-256 is `3d01dff5ec195d3163f855f0f754408cb4e4e4935d4b880a9a1e9b74ef7aa077` (the tag-named archive has a different top-level directory and therefore a different digest, `01c0af5e570463e6eaaa6251355cdb12b413e9026c437fa029ab7a559a3264d6`; the build uses the commit archive). That source pins libkrunfw to [`cf4c22b9f05c680928e6d96a9d198f5845573a87`](https://github.com/superradcompany/libkrunfw/tree/cf4c22b9f05c680928e6d96a9d198f5845573a87), the same gitlink as 0.7.2, and the three libkrunfw release assets are byte-identical to the 0.7.2 ones; its release workflow names libkrunfw 5.6.1.

| Rust target | `msb` asset and SHA-256 | `agentd` asset and SHA-256 | libkrunfw asset and SHA-256 |
| --- | --- | --- | --- |
| `aarch64-apple-darwin` | `msb-darwin-aarch64` `1dc5c7a9b28d85f06307a006394e8693e58fe31f9dc1e1919bf7d06c3706473e` | `agentd-aarch64` `373ce4e86abc9695dbc1da272591f877eb9072e4f9be7fc747178e2b025da386` | `libkrunfw-darwin-aarch64.dylib` `43e36ee2b1f2a7488c25f34193f657568a7733281d856ad267506ccc02993d59` |
| `aarch64-unknown-linux-gnu` | `msb-linux-aarch64` `781984850e178801508f8ec1ca12b44703242bc30481945cd9b301b3010acd03` | `agentd-aarch64` `373ce4e86abc9695dbc1da272591f877eb9072e4f9be7fc747178e2b025da386` | `libkrunfw-linux-aarch64.so` `98d01137190de7022a3132c6f55c245ef43d02d67d5d7e697ee19c303fce8769` |
| `x86_64-unknown-linux-gnu` | `msb-linux-x86_64` `b75244c1d0d24566009aa94d06f92b957cfd5affdf5550935dedc378cb0691e4` | `agentd-x86_64` `e0628a8ff7d00c1a349ee1002c8fec2e510ef118e9e1d4e08e0530e550be5d0c` | `libkrunfw-linux-x86_64.so` `ce9a749e8471e89aa5e2ad88de0c1581c3384c100bcb107a75bb12739a12d590` |

The release listing publishes SHA-256 values for these assets; for 0.7.4 every `msb`, `agentd` and libkrunfw asset in the table was downloaded on 2026-09-30 and hashed locally, and each digest equals the published one. The `checksums.sha256` listing digest is `79e60a721c7348bf86a7ae0b12fa1b7db41e81dcf14823e21dee295c9f8906d8`. Silo applies eleven ordered patches, each pinned by SHA-256 in `app/SiloUI/runtime-inputs.json`. Preflight validates their exact names, order, path containment, and bytes. The build cache key includes all patch hashes. Earlier macOS and Linux qualification cited above used the 0.7.2 runtime; it qualifies neither 0.7.4 nor any rebased patch.

Ordered source patch pins (all `-0.7.4.patch`; "Feature" is a Silo-specific capability, "Fix" corrects an upstream defect):

| Patch | SHA-256 | Kind | Purpose |
| --- | --- | --- | --- |
| `microsandbox-silo-network-0.7.4.patch` | `69d6f39d067f4caf18a84d65fb9bb064fb468153f39133900236e64c2bc1ff0c` | Feature | GitHub credential profile in the secrets handler; `ssh serve` and `exec` `--no-start`, managed authorized keys, machine-identity check and stdin-owned lifetime; the five original Silo protocol probes; SSH login directory is the user's home. |
| `microsandbox-restore-policy-0.7.4.patch` | `793b7c1950f8dbe455154dd8c060bf23711a63b049914c3a3a5fc685997a32fa` | Feature | Restore-time labels, environment defaults, host-sourced secrets and asymmetric network defaults, applied before restored execution. |
| `microsandbox-create-stopped-0.7.4.patch` | `3bbc8e5d89926685e2d8be576281b45dc17292a959008132f08b5a55afef270a` | Feature | `create --no-start` and `--progress-json`: persist prepared storage as `Created` without running guest code, with credential-free progress. |
| `microsandbox-adopt-owned-disk-0.7.4.patch` | `58a5084761f76743220220aa7656f227d48998788e255f47912e97f1fe111bae` | Feature | `adopt-disk`: convert a stopped sandbox's disk-image mount to an owned managed volume. |
| `microsandbox-log-retention-desktop-start-0.7.4.patch` | `bef402e7e94c0c382d71db73f6a30e57b01d854de32c28b58e7f8cc80e268f74` | Feature | Log retention shared with stopped sandboxes and desktop-start log handling (`logging_retention.rs` is byte-identical to `src-tauri/src/log_retention.rs`, checked by a test). |
| `microsandbox-restore-root-capacity-0.7.4.patch` | `f873cb36b746d18f80f37076ea1b45ec7852a78e57d66145bdaaa8e43854a92a` | Feature | Restored managed and flat root disks declare the captured capacity (Silo's export check compares it). Rounds a non-MiB capacity up rather than rejecting it. |
| `microsandbox-portable-image-cache-0.7.4.patch` | `4dcff8f9ea6f25d8c541a1625d7ac8796622c53f7692ce77e8a8442b32e50b9f` | Fix | Rebuild the imported image VMDK against the destination cache; upstream keeps the exporter's absolute extent paths (reproduced, see [upstream bugs](#upstream-defects-confirmed-against-v074)). |
| `microsandbox-live-public-ports-0.7.4.patch` | `c08b94b705d13d8e2b01008dc5ba7a7d921fe6e6b7ff7ddc320d74fa93119a08` | Feature | Add and remove public port publications on a running sandbox through the runtime control channel. |
| `microsandbox-secret-values-stdin-0.7.4.patch` | `4411bec2dae797f3c85eaa389e20fcb45a4ffe0b525e719d238a9d9427892312` | Feature | `MSB_SECRET_VALUES_STDIN=1`: secret `env` sources resolve only from a bounded JSON document on stdin; `--silo-secret-values-protocol` probe. |
| `microsandbox-import-stage-id-0.7.4.patch` | `ccbf71f5b718add94f7b0556b4224a540770484e08a0000e39a9ac25481dafe0` | Feature | `snapshot load --stage-id <32 hex>` so Silo can journal and clean exactly the staging paths of an interrupted import. |
| `microsandbox-sftp-user-0.7.4.patch` | `812987f168198e5708b4b6bae1a30e20b65f7c652f4855db5e6e6959cb1e618d` | Fix | Nonroot SFTP sessions run through the guest `sftp-server` under the SSH user; upstream runs them as root (upstream issue 1623). |

The former ninth patch (`microsandbox-preserve-basic-auth`, an independent Basic Auth substitution policy plus `query_params` normalization) is dropped for 0.7.4; the rationale is in [MicroSandbox 0.7.4 upgrade](#microsandbox-074-upgrade). Its 2026-09-27 verification (isolated `adopt-disk` on a copied catalog preserving `headers=true`, `basic_auth=true`, `query=false`, `body=false`) applies to the 0.7.2 runtime only.

The `secret-values-stdin` patch keeps secret values out of the runtime's environment (review items B-19/D-45 and B-28). Upstream 0.7.2 and 0.7.4 resolve every secret source of kind `env` from the `msb` process environment, which other processes of the same user can read, and which passes names chosen for secrets (for example `SSLKEYLOGFILE`) to the host runtime; its alternative `store` source kind is declared but unimplemented ("store-backed secret sources are not supported yet"). With `MSB_SECRET_VALUES_STDIN=1`, the patched CLI reads one bounded JSON object of source values from standard input before any thread starts, removes the flag so the sandbox process does not inherit it, and resolves `env` sources only from those values; the host environment is then never consulted, so a missing value fails closed. Without the flag, behaviour is unchanged. Silo sets the flag for every runtime command and sends the GitHub access profile (`SILO_GITHUB`) and the sandbox's assigned secrets this way, never as environment variables. The patch adds the `--silo-secret-values-protocol` probe, which the build requires. It changes the three places that read an `env` source (the network resolver, live secret rotation in `modify`, and the restore pre-check). On 2026-09-30 the ten-patch macOS CLI built (release, `net,ssh,embed-binaries`); the new `secret_values` unit test, the CLI probe test and the network resolver tests passed, and a smoke test of the built binary accepted a valid document, rejected malformed and oversized ones, and ignored standard input without the flag. It has not been exercised with a live VM on macOS or Linux, and the SDK's `modify` tests were not run.

The v0.7.2 release added, and v0.7.4 keeps, the supported snapshot/restore surface used by Silo. The build checks `create --mount-owned`, `create --no-start`, `create --progress-json`, snapshot creation, forked restore, the six exact Silo protocol probes, and managed SSH. The CLI is built with `net,ssh,embed-binaries` so the verified `agentd` payload is included. Silo no longer carries the 0.6.17-only Imago storage override; the pinned Imago source of v0.7.2 and v0.7.4 preserves logical disk length during discard.

The manifest records the target, versions, release assets, packaged filenames, and staged-input hashes without claiming one cross-platform runtime path. The observed macOS bundle layout is:

```text
Contents/MacOS/msb
Contents/Frameworks/libkrunfw.5.dylib
Contents/Resources/microsandbox/manifest.json
Contents/Resources/THIRD-PARTY-NOTICES.md
Contents/Resources/microsandbox/licenses/*
```

The app, sidecar, and library are signed together. The app and `msb` carry Apple's [Hypervisor entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.hypervisor). Library validation is not disabled. Signing changes Mach-O bytes, so the release hashes prove staged inputs, while the macOS packaged integrity check must validate the app signature. The app bundle declares macOS 14.0; the upstream `msb` Mach-O declares 11.0.

The later launcher must use only these private paths and set `MSB_PATH`, `MSB_LIBKRUNFW_PATH`, and an app-controlled `MSB_HOME`. Upstream resolves both environment paths first in its [runtime configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/config/mod.rs). It must not search `PATH` or a user's global MicroSandbox directory.

MicroSandbox is Apache-2.0. libkrunfw is LGPL-2.1-only and embeds GPL-2.0-only or compatible Linux sources. Exact license texts and source commits are in the bundle. Before external distribution, choose and review a compliant corresponding-source conveyance method. The current preparation is not release legal approval.

The `import-stage-id` patch adds `snapshot load --stage-id <32 lowercase hex digits>`.
Its exclusive snapshot and cache stage roots identify every unpacking and
publication directory before archive bytes are read, including external-base
archives. Silo journals `silo-import-<id>` first, passes that suffix as the stage
ID, and retries cleanup of precisely those paths and that group's indexed
members at launch. Missing paths are idempotent; collisions and symlinks are
refused. Random stages from older runtimes are preserved. Runtime preparation
requires the `--stage-id` capability for both cached and newly built executables.
The ordered patch SHA-256 above participates in the executable cache key and the
packaged manifest; no published release asset hash is substituted for a patched
build hash.

On 2026-09-30, this change ran `npm --prefix app/SiloUI run runtime:prepare`
in the isolated `fix/wd-e03` worktree. The release CLI at
`/Users/polarzero/code/projects/silo-wt/e03/app/SiloUI/src-tauri/binaries/msb-aarch64-apple-darwin`
has SHA-256 `a47001083c14e413614da1cc52ab577c6ff6002e659191567e63a08f3b562637`;
its version, six Silo protocol probes, and `--stage-id` capability passed runtime
preparation. The opt-in native test
`rebuilt_cli_killed_load_is_removed_by_next_launch_recovery` fed it a partial
1 GiB-declared tar disk entry through a FIFO, waited for actual extracted bytes,
and sent SIGTERM to that directly spawned child. Both exact stage roots survived
the killed load. Reloading Silo's durable journal and running production launch
recovery removed both roots, preserved three unrelated stage markers, and
cleared the import identity. No Silo app, VM, keychain, or user runtime was used.
This is fixture-only macOS CLI/recovery evidence, not an installed-app or Linux
qualification. Ordinary tests also cover a crash before spawning load,
preexisting-stage refusal, symlink refusal with journal retention, and the
inherited-worker lock. Logs are local in `/tmp/silo-codex/e03-*.log`.

## MicroSandbox 0.7.4 upgrade

Silo moved from v0.7.2 (`60d4dc8a436fb9365491567ec21d073e924e3c6d`) to v0.7.4 (`e36ffc0a58b48d70e0e4d66d75f1596994e3865a`, tagged 2026-09-29) on 2026-09-30. Upstream changed 320 files, including a rewritten `SandboxBuilder`/`create_sandbox` (builder-based creation), a config layer (`sdk/rust/lib/config/`), a cross-version compatibility layer for saved configurations (#1634, catalog migration `m20260922_000001_migrate_secret_config`), `msb snap` command aliases (#1619), `msb wait` (#1396), secret scanning scoped to request locations (#1666), and `allow_passthrough_for` renamed `allow_placeholder_for` (#1667). libkrunfw is unchanged. Every Silo patch was reapplied to the new source, rebuilt against the new APIs, and re-evaluated.

### Patch decisions

| Patch (0.7.2) | Decision | Evidence |
| --- | --- | --- |
| `silo-network` | Rebased | `crates/cli/lib/commands/ssh.rs` and `sdk/rust/lib/sandbox/ssh.rs` became async upstream; helpers and tests were merged by hand. Still no upstream `--no-start`, `--authorized-keys`, `--expected-machine-id` or GitHub profile. |
| `restore-policy` | Rebased | Applied cleanly. `--env` gained `-e` because a new upstream CLI test requires one short form for every repeated long flag. `allow_passthrough_for` became `allow_placeholder_for`. |
| `create-stopped` | Rebased | `create_sandbox` now takes a builder; the `start` flag is threaded through `create_with_mode`. No upstream create-without-start (`rg 'no_start\|LocalCreated'` finds nothing). |
| `adopt-owned-disk` | Rebased | Import lists and `HashMap` import merged. No upstream equivalent. |
| `log-retention-desktop-start` | Rebased | Applied cleanly on the new logging code; shared-rules byte check still passes. |
| `restore-root-capacity` | Rebased, one change | `apply_snapshot_root_layout` (`sdk/rust/lib/sandbox/builder.rs:2089-2110`) still declares `size_mib: None`. Non-MiB capacities are rounded up instead of rejected, because upstream's admission tests use 4096-byte fixtures that otherwise fail on the capacity error first. |
| `portable-image-cache` | Rebased | Applied cleanly. Defect still present at v0.7.4: `crates/image/lib/stitch/vmdk.rs:20-50`, `sdk/rust/lib/backend/local/snapshot/archive.rs:3711-3758`. |
| `live-public-ports` | Rebased | Applied cleanly; the network, protocol and runtime suites pass. |
| `preserve-basic-auth` | **Dropped** | See below. |
| `secret-values-stdin` | Rebased | Applied cleanly; upstream still reads `env` sources from the process environment (`crates/network/lib/model/config/resolver.rs`, `sdk/rust/lib/sandbox/modify.rs`). |
| `import-stage-id` | Rebased | Applied cleanly; `--stage-id` verified in the built CLI. |
| `sftp-user` | Rebased | Applied cleanly. Upstream SFTP still runs as the root agent (`sdk/rust/lib/sandbox/ssh.rs:1636-1690`); reported upstream as issue 1623. |

`preserve-basic-auth` had two jobs. First, accept saved 0.6.x secret configurations (`injection`, `query_params`, `on_violation`, `entries`). Upstream now does this: `packages/microsandbox-types/rust/lib/compat/v0_5_0/local/secrets.rs` and the catalog migration normalize every one of those spellings (tests `typed_reader_matches_saved_field_conversion` and the `config-0.6.18-*.json` fixtures). Second, keep Basic Auth as an independent scope. Upstream removed that scope on purpose: `legacy_header_scopes_merge_for_http1_and_http2` asserts that a saved `headers:false, basic_auth:true` policy becomes `headers:true`. That widens ordinary-header substitution for such a policy (reproduced against unpatched v0.7.4). Silo never writes such a policy: its secrets use `headers=true` with `basic_auth` true (0.6) or unset (0.7.2), and the one real record inspected was `headers=true, basic_auth=true, query=false, body=false`, which maps unchanged. Carrying a divergent secret-scope model through every future upstream compatibility change would cost more than the residual case, so the patch is dropped. Consequence: a hand-edited or third-party 0.6.x policy with Basic Auth on and ordinary headers off is widened when the catalog is upgraded.

### Upstream defects confirmed against v0.7.4

- Imported image VMDK descriptors keep the exporting machine's absolute cache paths. Reproduced without a VM: the patch's `imported_image_vmdk_uses_destination_cache_after_source_is_removed` test fails on unpatched v0.7.4 (`cold: VMDK does not point to imported extent`) and passes with `portable-image-cache`.
- SFTP through `msb ssh serve` acts as root for nonroot users. Upstream issue 1623 (open) reports it; Silo observed it live on Linux; the code path is `sdk/rust/lib/sandbox/ssh.rs:1636-1690` plus the root agent filesystem handler. Not reproduced in this change because it needs a running guest.

Not defects: legacy Basic Auth widening (deliberate, tested upstream) and the omitted restored root capacity (default-size metadata that Silo's export check needs; the disk itself is not shrunk).

### Verification and pins not updated

- `npm --prefix app/SiloUI run runtime:prepare` (aarch64-apple-darwin, Rust 1.94.0, `net,ssh,embed-binaries`) rebuilt the patched CLI in 6m04s, passed the version, six protocol-probe, `--mount-owned`, `--no-start`, `--progress-json`, `--stage-id`, managed SSH, snapshot-create and forked-restore checks, and staged the runtime. Packaged `msb` SHA-256 `35a70e48d8eb95d68002b33f3fbe8952d20e042a6b0b70c98805f22c82d04585`. Silo's `snapshot create --from-sandbox` is still accepted (upstream keeps it as a documented alias of `--sandbox`), so no caller changed.
- Upstream suites on the rebased tree, with `HOME` and `MSB_HOME` in a temporary directory and no VM: network 606, runtime 410, types 112 + 10, image 256, protocol 63 + 12 + 3 + 4, db 17, migration 33, cli 380 lib + 20 binary + integration, SDK 1146 lib + 63 `snapshot_artifact` + 4 `api_compat`. Suites that boot VMs (most other `sdk/rust/tests`) were not run.
- Silo: `test:release`, preflight, typecheck, lint, the full Vitest run, the Python script suite and the full native suite (`--test-threads=1`, synthetic GitHub configuration) pass. `src-tauri/Cargo.toml` and `Cargo.lock` now pin `microsandbox-image` and `microsandbox-utils` at the new commit.
- Pins updated from the release without a Linux build: the Linux `msb`, both `agentd` and the libkrunfw digests (all downloaded and hashed). The Linux patched CLI is not built or verified here; it needs the `linux-packaging` workflow. No 0.7.4 VM, migration or installed-app qualification was run on any platform.
- Risks to check before a release: (1) upgrading an existing catalog applies upstream's `m20260922_000001_migrate_secret_config`, which rewrites saved secret configurations and refuses to roll back global passthrough defaults (not exercised against a real Silo catalog here); (2) exports made by a Silo bundling 0.7.2 are accepted (`EARLIER_IMPORTABLE_RUNTIME_VERSIONS` lists `0.7.2`; the 0.7.4 runtime loaded and verified a 0.7.2 export, both using `msb-snapshot-tar-zstd-v0.7`); (3) all lifecycle, checkpoint, restore, SSH and public-port behaviour rebuilt on the new builder is covered by unit tests only.

## Pinned Git distribution

Silo packages the required client runtime from the matching tar archive in [dugite-native v2.53.0-4](https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4), commit [`4098283a7ecb8a227b9d43580336c78a06f90e5d`](https://github.com/desktop/dugite-native/tree/4098283a7ecb8a227b9d43580336c78a06f90e5d). Dugite-native is the portable Git distribution maintained for GitHub Desktop. The selected release is its current, GitHub-signed release and supplies upstream SHA-256 values. Its [stated roadmap](https://github.com/desktop/dugite-native/blob/4098283a7ecb8a227b9d43580336c78a06f90e5d/README.md#roadmap) tracks stable Git updates. This makes the pin suitable now, but release work must still monitor new Git and dugite-native security releases. Silo retains [Git 2.53.0](https://github.com/git/git/tree/67ad42147a7acc2af6074753ebd03d904476118f), [Git LFS 3.7.1](https://github.com/git-lfs/git-lfs/tree/b84b33847fe6458f36ef521534dc0eac953cb379), Git's HTTPS transport, templates, and the Linux CA certificate bundle. It excludes Scalar, Git Credential Manager, server programs, and unrelated helpers. Later pushes must use only short-lived Silo-controlled credentials.

| Rust target | Dugite-native archive | SHA-256 |
| --- | --- | --- |
| `aarch64-apple-darwin` | `dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz` | `f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe` |
| `aarch64-unknown-linux-gnu` | `dugite-native-v2.53.0-4098283-ubuntu-arm64.tar.gz` | `a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af` |
| `x86_64-unknown-linux-gnu` | `dugite-native-v2.53.0-4098283-ubuntu-x64.tar.gz` | `cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901` |

Preparation uses the same target selection as MicroSandbox, verifies the complete upstream archive before extraction, rejects unsafe archive paths and unsupported targets, retains the explicit client-runtime allowlist, checks Git, Git LFS, HTTPS transport, templates, certificates, executable modes, and contained symbolic links, then replaces `src-tauri/runtime/git/`. It also materializes target-qualified Tauri sidecars for Git and each helper under the ignored `src-tauri/binaries/` directory. Materializing `git-remote-https` removes the upstream helper symlink before relocation, so no packaged link can point into the staging or build tree. Generated archives, caches, sidecars, and extracted files remain ignored. Node and `tar` are build-time tools only; the Tauri app has no Node runtime and performs no runtime download.

Tauri packages the executables next to the app executable and signs each one through its established sidecar path. It packages templates, licenses, the manifest, and the Linux certificate bundle under the resource directory. The later native adapter must resolve these fixed packaged paths:

```text
<executable directory>/git
<executable directory>/git-lfs
<executable directory>/git-remote-http
<executable directory>/git-remote-https
<resource directory>/git-support/share/git-core/templates
<resource directory>/git-support/ssl/cacert.pem       Linux only
<resource directory>/git-support/manifest.json
<resource directory>/git-support/licenses/*
```

It must invoke the packaged `git` by absolute path. It must set `GIT_EXEC_PATH` to the executable directory, `GIT_TEMPLATE_DIR` to the private template tree, and the Linux `GIT_SSL_CAINFO` to the private certificate bundle. Its fixed process environment must set `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`, a Silo-owned `HOME` and `XDG_CONFIG_HOME`, and a fixed `PATH` containing the executable directory and only required operating-system utility shims. It must never inherit the user's `PATH` or Git configuration. Required credentials must be supplied for one operation by the native adapter, not persisted in the VM.

Every packaged Mach-O executable must pass individual signature verification after packaging. A successful `git --version` or outer `codesign --deep` check alone does not establish this. Tauri does not re-sign executable files copied as resources, so Git, Git LFS, and both HTTPS helper names are configured as external binaries instead. Tauri's [macOS bundler source](https://github.com/tauri-apps/tauri/blob/tauri-bundler-v2.9.4/crates/tauri-bundler/src/bundle/macos/app.rs) adds every external binary to the inner-to-outer signing list. It signs each with the configured identity and hardened-runtime option before it signs the outer app. The debug configuration applies ad hoc hardened-runtime signatures. A release build applies the configured Silo identity to every executable through the same Tauri signing operation. Git declares macOS 11.0 and Git LFS declares macOS 12.0. Both are below Silo's declared macOS 14.0 minimum.

The macOS archive contains no private dynamic libraries in the retained runtime. Git links to the system CoreServices and CoreFoundation frameworks plus `libz`, `libiconv`, and `libSystem`. Its HTTPS helper also links to system `libcurl` and `libexpat`. Git LFS links to `libSystem`, `libresolv`, CoreFoundation, and Security. These are platform libraries covered by Silo's macOS minimum.

The Linux archives were built on Ubuntu 22.04 and reference glibc 2.34. Git directly requires glibc and `libz`; Git LFS is static. The HTTPS helper directly requires glibc, `libz`, and `libcurl.so.4`. The Tauri Debian configuration now declares `libc6 (>= 2.34)`, `libcurl4 | libcurl4t64`, and `zlib1g`; the RPM configuration declares `glibc`, `libcurl`, and `zlib`. Tauri's RPM dependency setting cannot express a minimum version, so RPM release validation must separately reject glibc older than 2.34. Tauri's [AppImage bundler source](https://github.com/tauri-apps/tauri/blob/tauri-bundler-v2.9.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs) creates Debian-style data first, placing every external binary in `usr/bin` before linuxdeploy scans the existing ELF files and copies non-baseline shared-library dependencies into the AppDir. A Linux AppImage build must still verify that the produced image contains a usable `libcurl.so.4` chain. MicroSandbox alone can run with glibc 2.28, but bundled Git raises Silo's combined Linux floor to glibc 2.34.

### Linux AppImage payload integrity

The pinned `@tauri-apps/cli` 2.11.4 path copies Debian payloads into the AppDir and invokes linuxdeploy with the GTK plugin and AppImage output. The Tauri v2.11.4 [AppImage bundler source](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs) inherits the build process environment when it launches linuxdeploy. linuxdeploy upstream supports `NO_STRIP=1` to skip its ELF stripping step; its maintainers confirm that option in [issue #72](https://github.com/linuxdeploy/linuxdeploy/issues/72). Set it on the Tauri build process only when before/after evidence attributes a packaged payload hash change to stripping. It does not disable RUNPATH changes: upstream linuxdeploy enumerates ELF files in `AppDir/usr/bin` and recursively under `AppDir/usr/lib`, then assigns relative RPATHs to those files ([scanner and rewrite code](https://github.com/linuxdeploy/linuxdeploy/blob/master/src/core/appdir.cpp)). `--exclude-library` filters dependency deployment, not those existing-file rewrites. Tauri's `bundle.linux.appimage.files` copies additional files into the Debian data tree before this scan, so it is not an exclusion switch; a destination outside the scanned directories requires moving the product's runtime lookup there and avoiding the normal `externalBin`/`resources` placement. The Linux package-only overlay now does this for managed ELF tools: preparation copies the five hash-verified external binaries and `libkrunfw.so.5.6.1` to ignored `runtime/linux-package/tools/`; AppImage, Debian, and RPM custom-file mappings install them under `/usr/libexec/silo/tools`. Packaged Linux runtime and dependency checks resolve that shared directory; normal development sidecars, resource manifests, guest image, Git support, help, notices, release metadata, and the user-installed `silo-remote` bridge retain their existing routes. Compare prepared runtime hashes, AppDir payload hashes, and the extracted AppImage against embedded manifests before accepting a package; if hashes still differ, inspect ELF dynamic sections and bytes to identify the transforming step. Never bypass Silo's packaged integrity checks.

Git and dugite-native use GPL-2.0. Git LFS uses MIT plus its recorded component terms. The Linux CA bundle is curl's conversion of Mozilla's CA store and uses MPL-2.0. Exact pinned license texts are packaged under `git-support/licenses/`. External distribution still requires legal review and a compliant corresponding-source offer for GPL components.

## Approved push boundary

The future native implementation keeps two push routes:

- When VM pushes are enabled, tools in the VM may push through Silo-controlled GitHub access. GitHub credentials remain on the host.
- When VM pushes are disabled, guest pushes stay blocked. The user may select commits and click Push in Silo, which pushes from the host.

App Push never grants standing push permission to the VM. It uses the bundled Git and Git LFS, standard Git transfers, only required committed Git/LFS data, and incremental transfer where the protocol supports it. This section settles packaging and the push boundary. It does not claim that either route or native GitHub credential forwarding is implemented.

## Resource and VM backup UX recommendation (2026-09-08)

Research recommendation only; no UI or backup implementation is approved by this section.

- Onboarding should show genuine compatibility and packaged-runtime checks. There is no measured basis for a universal 16 GiB RAM or 20 GiB free-space gate. Check capacity when creating, starting, backing up, or restoring a selected VM. Show an actionable shortage at that operation; do not add a permanent capacity checklist or invent a minimum when no defensible requirement exists.
- RAM admission must account for the selected VM and host pressure, rather than treating unused RAM as the available budget. [Apple documents memory pressure](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac) as a combination of free, cached and wired memory and swap activity; Linux documents `MemAvailable` as an estimate accounting for reclaimable memory in [procfs](https://docs.kernel.org/filesystems/proc.html). Performance estimates warrant warnings, not unsupported hard minimums. Runtime overhead and any reserve still require measurement.
- Disk admission should use the selected operation's missing image data, copied/expanded data, archive overhead and temporary storage, checking each affected volume. Account for sparse disks and shared image caching. Do not assume a compression ratio or promise that a successful precheck reserves disk space. Report write failures truthfully and preserve existing backups.
- Ship VM backup through the already bundled MicroSandbox snapshot/archive implementation. It includes tar and zstd internally, so users need no archive commands and Silo needs no second archive engine for this initial managed-VM backup path. The [archive implementation](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/snapshot/archive.rs) supports image inclusion and parent inclusion, sparse disk export, temporary output and transport integrity. Select a self-contained export including the required image and ancestors, and preserve Silo's VM configuration alongside it.
- Recommend managed disks for Silo-created VMs. The pinned [snapshot creation implementation](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/snapshot/create.rs) rejects running/paused VMs, resumable snapshots, flat disks, user-owned disk-image roots and memory-only roots. Gracefully stop a running VM with a clear interruption notice, capture the immutable disk snapshot, then restart it if it was previously running while exporting the captured snapshot. Never describe this as saving running programs or promise interruption-free backups.
- A managed-disk snapshot does not include arbitrary host folders or additional external disks. Keep Silo-owned workspace data inside the managed VM disk for the simple complete-backup path. If a VM uses external storage, identify that exception and explicitly include it through a later supported path or report the backup limitation; never label omitted VM data as a complete backup.
- Before release, prove restore into a fresh compatible VM from the exported artifact with the original VM and image cache unavailable. Verification must cover VM configuration and disk data, failed export, restart failure, and unsupported storage. Source inspection establishes a suitable implementation path; it is not a completed backup/restore test.

## Dependency assessment

No SiloUI native code currently invokes Git, Git LFS, tar, gtar, or zstd. The visible backup and repository operations are fixtures.

| Current row | Finding | Recommendation requiring approval |
| --- | --- | --- |
| `git` | Approved and packaged for future host-side pushes. Native push and preflight invocation are not implemented. | Keep the current row unchanged. Later read-only preflight must run only bundled `git --version`. |
| `git-lfs` | Approved and packaged with Git for future host-side LFS pushes. Native push and preflight invocation are not implemented. | Keep the current row unchanged. Later read-only preflight must run only bundled `git-lfs version`. |
| `tar / gtar` | No current native consumer. MicroSandbox implements snapshot tar handling in Rust in its [snapshot archive module](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/snapshot/archive.rs). Silo does not use the separate upstream installation shim that shells out to tar. | Remove from onboarding now. Select a library when Silo's real backup boundary is implemented. |
| `zstd` | No current native consumer. The same upstream snapshot module performs zstd compression internally. | Remove from onboarding now. Select a library when Silo's real backup boundary is implemented. |

The remaining thresholds also lack a current SiloUI requirement:

- `macOS 26+`: unsupported by the package evidence. The app declares 14.0, but compatibility still needs a real oldest-host test before changing the label.
- `Apple Silicon`: supported. The pinned upstream macOS release has only an arm64 artifact.
- `20 GiB free`: no measured Silo plan supports this fixed minimum. Upstream currently defaults each managed writable root disk to 4 GiB in its [sandbox configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/sandbox/config.rs), but actual image, workspace, and backup budgets vary.
- `16 GiB memory`: no measured Silo plan supports this fixed minimum. Upstream defaults one sandbox to 512 MiB in its [global configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/config/mod.rs).

Pending decisions, unchanged by this work:

1. May we remove the `tar / gtar` and `zstd` onboarding rows and defer each check to its actual feature?
2. May we replace or defer `macOS 26+`, `20 GiB free`, and `16 GiB memory` after compatibility and capacity tests establish real thresholds?

This preparation leaves every row, label, layout, and interaction unchanged.

## Proposed real checks

1. Resolve the app-private manifest, sidecar, and library by fixed platform layout; validate the manifest schema, pinned target and versions, files, and the macOS bundle signature or Linux staged hashes. Run only packaged `msb --version` with fixed arguments, bounded output, private environment paths, an empty `MSB_HOME`, and fixed per-probe and total timeouts; require its output to match the pinned version.
2. On macOS require macOS at or above the bundle minimum, `arm64`, and Apple's documented [`kern.hv_support`](https://developer.apple.com/documentation/hypervisor) value of `1`. On Linux require the CPU to match a packaged `aarch64` or `x86_64` target, glibc 2.34 or newer for the combined package, and [`KVM_GET_API_VERSION`](https://docs.kernel.org/virt/kvm/api.html#kvm-get-api-version) on `/dev/kvm` to return `12`; close the descriptor without calling `KVM_CREATE_VM` or otherwise creating a VM. MicroSandbox alone supports glibc 2.28 under its [upstream platform requirements](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/docs/cli/overview.mdx), but bundled Git raises Silo's current Linux floor to 2.34.
3. Treat missing, unsupported, permission-denied, timed-out, malformed, and invoke-failure results as unsuccessful; none may pass by fallback or absence.
4. Add read-only bundled `git --version` and `git-lfs version` probes to the remaining native preflight integration. Resolve only the private paths and isolated environment above. These probes prove the selected versions, not HTTPS helper or push usability. Keep deterministic fixtures isolated to tests and explicit fixture launches. Do not add archive-tool, installation, repair, sandbox-creation, legacy handshake, or `msb doctor` checks.
5. Add focused native success and failure tests. Assert the exact complete state and that `Continue` enables only after every required check succeeds. Assert the exact failure detail and remediation, disabled `Continue`, and keyboard Space toggling of the disclosure's `aria-expanded` state and detail visibility.

## MicroSandbox packaging verification record

- `npm --prefix app/SiloUI test -- src/test/microsandbox-runtime.test.ts src/features/onboarding/components/onboarding-preparation.test.tsx src/features/onboarding/onboarding-app.test.tsx src/features/onboarding/onboarding-flow.test.tsx src/features/onboarding/onboarding-recovery.test.tsx src/features/onboarding/onboarding-source.test.tsx`: 6 files and 67 tests passed.
- `npm --prefix app/SiloUI test`: 40 files and 369 tests passed.
- `npm --prefix app/SiloUI run typecheck`: passed.
- `npm --prefix app/SiloUI run lint`: passed.
- A disposable fresh-checkout simulation started with the ignored `src-tauri/binaries/` and `src-tauri/runtime/` inputs absent. `npm run desktop` executed `beforeDevCommand`, preparation restored the target-qualified sidecar, manifest, library, and licenses from the validated cache, and a fail-fast Rust wrapper confirmed those files existed at the first Rust invocation. The wrapper then exited intentionally, so this check did not launch the app or another Vite server.
- `cargo test --offline --manifest-path app/SiloUI/src-tauri/Cargo.toml`: 37 tests passed.
- `npm --prefix app/SiloUI run desktop:build:debug`: passed; built `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app`.
- `codesign --verify --deep --strict --verbose=2 "app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app"`: passed. The app, `msb`, and libkrunfw also passed strict component verification; `msb` has `com.apple.security.hypervisor=true`.
- Isolated packaged `msb --version`: returned `msb 0.6.17` and wrote no files under empty `HOME` and `MSB_HOME` directories.
- Exact bundle executable launched with a fresh `SILO_SETTINGS_DIR`, wrote only its isolated `settings.json`, quit through AppleScript, returned status 0, and left no `silo-preview` process.
- `TAURI_ENV_TARGET_TRIPLE=aarch64-unknown-linux-gnu npm --prefix app/SiloUI run runtime:prepare` and the x86_64 equivalent selected the requested cross-build artifact pairs and matched all pinned hashes. Read-only `debian:bookworm-slim` arm64 and amd64 containers each returned `msb 0.6.17` with staged paths mounted read-only and no files under empty `HOME` or `MSB_HOME`.
- Playwright captured current complete collapsed/expanded and dependency-failure collapsed/expanded states at 1160 by 820 under `src-tauri/target/visual-baseline/`. The before screenshots were overwritten, so this evidence verifies current semantics and styling, not a pixel comparison. Keyboard Space toggled the disclosure. Navigation, shared row styling, Applications controls, and footer controls remained unchanged; only approved dependency content and occupied height changed. This is fixture UI evidence, not native preflight evidence.

That MicroSandbox work did not test Linux Tauri bundling, KVM access, VM startup, or oldest-supported-macOS behavior. Its Linux execution coverage was limited to read-only `--version` under Docker. No VM, installer, repair, sandbox, or `msb doctor` command ran.

## Git packaging verification record

- `npm test -- --run src/test/git-runtime.test.ts src/features/onboarding/components/onboarding-preparation.test.tsx`: 2 files and 19 tests passed. These cover target selection, hashes, unsafe archives and links, missing helpers, modes, relocation, manifest paths, Tauri sidecar signing inputs, Linux dependency declarations, and the unchanged dependency view.
- `npm run typecheck` and `npm run lint`: passed. The debug build also reran the TypeScript and Vite production builds successfully.
- `npm run desktop:build:debug`: passed. The bundle is `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app`. A stale ignored `target/debug/git/` directory from the earlier resource layout blocked one rebuild and was removed; a fresh build has no file/directory collision.
- `codesign --verify --deep --strict --verbose=2` passed for the app. Individual strict verification passed for `git`, `git-lfs`, `git-remote-http`, and `git-remote-https`. Tauri replaced every upstream signature with the app's ad hoc debug identity and hardened-runtime signature. The packaged helpers are regular files, not staging-path symlinks.
- `node scripts/verify-git-runtime.mjs ".../Contents/Resources/git-support" ".../Contents/MacOS"` passed with an empty isolated home, disabled system and global Git configuration, a private Git/helper path plus one `/bin/sh` shim, and no global Git executable. Packaged Git returned `git version 2.53.0`; packaged Git LFS returned 3.7.1; the HTTPS helper reached its usage path. A disposable bare remote received one standard Git push and its LFS object. The second identical push reported no changes; this is a repeat/no-op check, not a measurement of incremental-transfer efficiency.
- Target-qualified preparation passed for `aarch64-unknown-linux-gnu` and `x86_64-unknown-linux-gnu`. Disposable Ubuntu 22.04 arm64 and amd64 containers had no global Git, installed only the declared `libcurl4` validation dependency, and ran the exact staged Git, Git LFS, and HTTPS helper. Each pushed Git and LFS data to a local bare remote and completed an unchanged second push. The arm64 artifact reports `git version 2.53.0.dirty`; the manifest requires that exact upstream output.
- ELF symbol inspection confirmed glibc 2.34 for Git and the HTTPS helper on both Linux targets. The helper names `libc.so.6`, `libz.so.1`, and `libcurl.so.4`; Git LFS has no glibc symbol requirement.
- The production UI source did not change. No screenshots were written or overwritten. The existing Git and Git LFS rows remain unchanged.

Tauri's AppImage source path was inspected: it creates Debian-style data first, so the external Git executables are in `usr/bin` before linuxdeploy scans existing ELF files. This coverage does not include a produced Linux Tauri bundle, so it does not prove the final AppImage's libcurl chain. It also excludes an actual HTTPS or GitHub push, real credentials, VM forwarding, KVM, a VM, native preflight commands, oldest supported hosts, notarization, and release-identity signing. It does not implement either approved push route. No user repository changed, and no installer, repair flow, sandbox command, or `msb doctor` ran.


## Git LFS pure SSH publishing server (2026-09-16)

Host-authorized publishing stages a Linux guest helper from
[charmbracelet/git-lfs-transfer](https://github.com/charmbracelet/git-lfs-transfer/tree/971c0284dc33b1ed3f7ed9dde5d4fc0cee62db6b),
commit `971c0284dc33b1ed3f7ed9dde5d4fc0cee62db6b`. The source archive SHA-256 is
`92d6720202aa5a059c6683df78f1fa47722c0c48ff1dc4ebfc0bc8137d988702`.
There is no stable release asset; the only published binary release is a mutable
2023 nightly. Preparation therefore verifies the pinned source archive and builds
it with Go 1.25 or newer, `CGO_ENABLED=0`, `GOOS=linux`, `-mod=readonly`,
`-trimpath`, and `-buildvcs=false`. The host target selects ARM64 or AMD64 guest
code. Runtime preparation stages `runtime/lfs-transfer/`; Tauri packages it under
`git-support/lfs-transfer/`. The manifest records the source pin, archive hash,
guest architecture, and executable SHA-256. Source and verified builds are cached
under `target/runtime-cache/git-lfs-transfer/`; dependency modules are checked
against upstream `go.sum` and the public Go checksum database.

The package includes the upstream MIT license, compiler runtime license, and
license/notice files for the external modules actually linked for that guest
architecture. The Go compiler is a build dependency, not an application runtime
dependency. The helper is copied to an operation-specific guest temporary directory;
existing sandboxes need no image rebuild.

The upstream server uses a conventional `lfs/objects` tree and does not resolve
`lfs.storage` or linked-worktree configuration itself. Silo asks guest Git LFS for
`LocalMediaDir` and exposes that directory through an operation-specific server
view. Git LFS continues to choose and validate objects through its native protocol.
An absent guest cache uses an empty view, preserving the guest repository state.

Prototype evidence uses bundled Git LFS 3.7.1 and the pinned server over a local
SSH shim. It covers empty content, objects reachable only from earlier commits,
source-pruned objects already present at the destination, and new objects missing
from both locations. The final ordinary `git lfs push` rejects missing required
objects. Pure SSH fetch can exit successfully with server-side objects absent;
fetch success alone does not establish completeness. On two historical 6 MB
versions, a cold source transfer used 12,001,358 protocol bytes; a repeat with an
existing host cache used 275 bytes. Local timings were 0.209 s and 0.157 s. These
measurements establish cache bandwidth savings, not live VM or SSH-network latency.

B-28 source mapping: each general secret keeps its guest name and placeholder,
but the CLI records an opaque `SILO_SECRET_<number>` source. The number is the
big-endian decimal value of the first 128 bits of SHA-256 of the guest name; it
is stable across assignment order, additions and removals. Silo sends values
under these generated names on stdin and refuses duplicate sources. The CLI's
create, modify and restore adapters use the same mapping only when stdin
transport is enabled. `SILO_GITHUB` remains the reserved GitHub protocol source.
The shared reserved-name list guards guest settings, independently of transport.

Primary-source gap verified in the pinned
[CLI network adapter](https://github.com/superradcompany/microsandbox/blob/60d4dc8a436fb9365491567ec21d073e924e3c6d/crates/cli/lib/commands/common.rs):
the parser persists the guest name as its environment source and offers no
separate source-name option. This small bundled upstream patch supplies the
mapping at the existing adapter seam; no credential broker or storage service
is added. The source patch retains the upstream license and existing runtime
build, packaging, and protocol-probe checks.

The build and smoke-test record above predates the generated source mapping.
For the mapping revision, the focused upstream secret-values test and Silo's
transport and secret-configuration tests pass. The patched CLI compiled with `net,ssh,embed-binaries`; its five secret-parser
tests and protocol-probe test passed. The patch applied through the production
build helper and every manifest patch digest matched. Live VMs remain unverified.

## Inactive-disk migration (review D-25)

The owned-disk adoption patch accepts Created, Stopped and Crashed sandboxes.
Migration inspects the staged copy first: MicroSandbox reconciles a dead Running
process to Crashed, then Silo admits that inactive state. Active states remain
blocked. Adoption copies and verifies the external disk without starting guest
code or changing lifecycle status. Source files remain intact.

The pinned [MicroSandbox reconciliation source](https://github.com/superradcompany/microsandbox/blob/60d4dc8a436fb9365491567ec21d073e924e3c6d/sdk/rust/lib/backend/local/sandbox/mod.rs)
checks process ownership before marking a stale run Crashed. Its
`test_reconcile_sandbox_runtime_state_marks_dead_processes_crashed` regression
and the adoption patch's fixture tests exercise this boundary without a VM.
Silo's migration regression requires exactly inspect, adopt-disk and inspect.
These tests do not qualify live migration or a packaged app.

### Verification of D-25 and F-08 patches (2026-09-30)

`npm --prefix app/SiloUI run runtime:prepare` rebuilt the ten-patch runtime
in the isolated `fix/wc-patches` worktree with Rust 1.94.0, Node 24 and Go 1.25.
The macOS ARM64 sidecar SHA-256 is
`99b8b7ed9b2c346a88a7b6b0c8425c9f06a28f02b2b5a2aebeebf2571fdac6cd`.
Its manifest matches every current patch pin. Version, all six Silo protocol
probes and `adopt-disk --help` passed. A disposable catalog/disk fixture with
no guest image exercised the built sidecar: direct Crashed adoption passed;
a stale Running row inspected as Crashed and then adopted successfully.
Both paths retained Crashed status and preserved original, staged and owned
disk bytes. No VM or Silo app was started.

The upstream adoption and dead-process reconciliation tests passed, as did
11 logging tests and five execution-log tests. The shared retention source
and patch passed the Vitest byte-identity and digest checks. Flood regressions
failed with the old shared budget, then passed with independent 125 MiB
execution and console budgets. Silo's migration regression likewise failed
before admitting Crashed, then its 16-test migration suite passed. These are
fixture, build and CLI results, not live migration or packaged-app qualification.

### Adoption from the previous generation (2026-10-01)

Migration no longer stages a copy of each `volumes/<name>/workspace.raw`. It
runs `adopt-disk` without `--source`, so adoption reads the disk the staged
sandbox already names in the previous generation and writes only the owned
copy. The staged copy had stayed in the converted storage as an unused
duplicate. On filesystems without reflinks, such as ext4, it held as much
space as the workspace, and the upgrade briefly needed three copies.

Silo's migration suite asserts the bare `adopt-disk <name>` call, no staged
workspace disk, a copied configuration-ownership marker and an unchanged
previous generation. The duplicate assertion failed with the old copy. On
macOS ARM64, the bundled sidecar (SHA-256
`101118e812ea79127c5ecff900100591b7d8cf569df66db590867643bef12576`) adopted a
`--no-start` fixture's 8 MiB sparse disk without `--source`. The sandbox stayed
Created and the mount became Owned. The owned copy matched byte for byte. The
source's hash, size, mtime and inode were unchanged. No VM or Silo app was
started; this is not live migration or packaged-app qualification.

### Pre-upgrade backup (2026-10-01)

After a migration that converted every sandbox, `<app data>/runtime` is a
pre-upgrade backup: nothing reads it, downgrading is not supported, and on a
filesystem without reflinks (ext4) it is a second full copy of every sandbox
disk, the image cache and the database. On APFS the copies are clones, so
deleting frees less than the allocated size Silo shows. Silo keeps it for 14
days and then deletes it; the owner can delete it sooner. The migration screen
reports its size and the date it will be deleted, and Settings, General,
Storage lists it with **Show** and **Delete now** until it is gone.
`src-tauri/src/pre_upgrade_backup.rs` owns this.

- **Only after a complete conversion.** The folder is offered, measured,
  revealed and deleted only while `runtime-migration.json` reports `complete` and
  `runtime-generation.json` selects `runtime-checkpoints-converted`
  (`runtime_migration::previous_generation_is_backup`). After "Continue" the
  generation is `runtime-checkpoints-clean` and the same folder holds the only
  copy of the unconverted sandboxes, so none of this applies. Without a
  generation file nothing was migrated.
- **Window.** The 14 days start when Silo first sees the migration complete,
  which is the first launch after the conversion restarts. An install that
  migrated before this feature has no record, so its window starts at its first
  launch with it. The start is stored in a separate `pre-upgrade-backup.json`
  (`version`, `startedAt` in RFC 3339 UTC, `noticeAcknowledged`), not in
  `runtime-migration.json`: that reader rejects unknown fields, so builds
  without this feature would refuse a changed file. They never read the new
  one. A record that is damaged or has another `version` is kept untouched;
  the backup is still offered and can be deleted by hand, but Silo never
  deletes it automatically.
- **Schedule.** Checked at launch and then hourly while Silo runs. A backup
  that came due while Silo was closed is deleted at the next launch. Hourly
  rather than daily because the sleep does not count time the computer spent
  asleep, and a check that finds nothing due reads one small file. The date
  shown is the local calendar date of the deletion instant (14 x 24 hours after
  the start); no countdown is shown. A clock set far forward would delete early;
  a clock set back never does.
- **Deleting.** Exactly `<app data>/runtime`, with `remove_dir_all`, which
  unlinks symlinks instead of following them. A symlink or non-directory at
  that path, or the folder Silo currently reads from, is refused. One deletion
  runs at a time; a concurrent or repeated request waits and then finds nothing
  to delete, which succeeds. A failure part-way (permissions, I/O) keeps the
  rest, the record and the Settings row, and reports the cause so the user can
  retry. Before deleting, Silo runs the image-cache repair and refuses if any
  converted image descriptor still names a file below the backup, because a
  sandbox whose image reads from the backup stops booting once it is gone
  (see `runtime/image_cache.rs`). It does not remove the runtime-home alias
  symlink that the previous generation left under `~/.silo` (or `~/.silo-dev`);
  that is a dangling link outside the backup folder.
- **Size** is allocated bytes (`st_blocks`), not apparent size, so a sparse
  disk image counts what it occupies; symlinks are not followed and a file with
  several names counts once. It is a separate command (`measure_pre_upgrade_backup`)
  that runs off the async workers and only where the size is shown, so reading
  the status at launch never walks the folder.
- **Show** reveals the folder with the same `tauri_plugin_opener::reveal_item_in_dir`
  as exports. The folder holds Linux disk images (`upper.ext4`, `workspace.raw`)
  and a database: copyable, not browsable on macOS.
- **Quarantined files.** The migration moved the previous export journal and
  export-folder setting into the folder as `before-checkpoints-backup-operation.json`
  and `before-checkpoints-backup-history.json` so they are not replayed against the
  new runtime. Nothing reads them back: the journal can only be terminal at that
  point (conversion refuses an unfinished one), and the history only remembers
  an export folder and, in older builds, a list of exports that no UI showed.
  The export files themselves are elsewhere and are not touched.

Existing tools considered: a launchd agent or systemd timer would run while Silo
is closed, but deleting needs Silo's own migration state and image-cache check
in the same process, and Silo already runs its other maintenance (storage
reclaim, log retention) from a monitor thread. The new code is date arithmetic,
a guarded `remove_dir_all` and one small file.

Verification: native unit tests cover the date arithmetic across month, year and
leap boundaries, the clean-generation, symlink and in-use refusals, legacy installs
without a record, past-due deletion at launch, idempotent and concurrent deletion,
symlinks inside the backup, a failed deletion keeping its row, damaged and
later-version records, sparse and hard-linked sizes, and the image-descriptor
check. Frontend tests cover the migration screen, the Settings row, the confirmation,
failure and retry against fixtures, and the native JSON contract. None of this
deleted a real migrated install or booted a converted VM after deleting its
backup.

### SFTP working-account identity

The `sftp-user` patch runs nonroot SFTP sessions through the guest's bundled OpenSSH
`/usr/lib/openssh/sftp-server` and the existing identity-aware exec stream.
The pinned upstream's filesystem RPC handler runs as root even when the SSH
session authenticates as `silo`; a real Linux Zed extension upload exposed
root-owned upload directories and a subsequent rename permission failure.
Root sessions retain the original handler. A missing guest helper fails without
falling back to root. The guest image already requires this executable.

[OpenSSH's subsystem manual](https://man.openbsd.org/sftp-server) documents its
stdin/stdout protocol. The [pinned SDK SSH handler](https://github.com/superradcompany/microsandbox/blob/60d4dc8a436fb9365491567ec21d073e924e3c6d/sdk/rust/lib/sandbox/ssh.rs)
shows the original root-agent SFTP path. Live evidence and qualification limits
are recorded in [the Linux verification session](research/linux-verification-2026-09-30.md).

The same patch sets SSH command `USER` and `LOGNAME` to the effective guest user,
after client environment requests. The offline Linux account regression found
these unset even though UID/GID and HOME were correct.
