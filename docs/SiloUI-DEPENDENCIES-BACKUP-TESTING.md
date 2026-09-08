# Test dependencies and VM backups in the real app

Use `app/SiloUI`, not the Swift reference app. The normal native app now uses
real VM state and operations. It has no fixture launch flags, fake operation
results or settings-directory overrides.

## Build and launch

From the repository root:

```sh
npm --prefix app/SiloUI test
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml
RUSTUP_TOOLCHAIN=1.94.0 npm --prefix app/SiloUI run desktop:build:debug
codesign --verify --deep --strict \
  app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app
open app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app
```

Quit an existing instance normally before launching the rebuilt app. Do not
launch an installed copy with `open -a Silo`. The executable is
`Silo.app/Contents/MacOS/silo-ui`. The visible name is Silo; the stable internal
identifier retains existing preferences and OS permissions.

The first build downloads pinned build inputs and compiles the patched runtime.
It requires Rust 1.94.0. Users of the finished app need none of those build tools.
For an isolated manual run, build a separate application identity through Tauri's
`--config` option; this uses the same production code with its own real data.
Do not add fixture hooks or edit user settings to simulate states.

## Dependencies

On a fresh app identity, open onboarding's Dependencies step:

1. System and Bundled tools show checking states. Continue stays disabled.
2. Expand both groups. A supported Apple-silicon Mac shows macOS/hypervisor and
   packaged MicroSandbox, Git and Git LFS results. Normal captions use one line;
   error details may wrap.
3. Continue enables only when every required check succeeds. Keyboard Space and
   Enter operate the existing disclosures; focus and light/dark appearance stay
   unchanged.
4. A failed check shows its concrete error and Retry checks. Retrying resets the
   results while new read-only probes run. No install or repair happens here.

macOS checks the declared macOS 14 floor, arm64 target and `kern.hv_support`.
Linux checks a supported GNU/Linux target, glibc 2.34 or later, access to
`/dev/kvm` and KVM API version 12. It never creates a VM to probe support.
Both validate bundled files and bounded version commands. Failed, unsupported,
unreadable and timed-out results cannot pass.

References: [Apple Hypervisor](https://developer.apple.com/documentation/hypervisor),
[KVM API](https://docs.kernel.org/virt/kvm/api.html#kvm-get-api-version),
[Tauri sidecars](https://v2.tauri.app/develop/sidecar/).

## VM configuration

Use disposable VMs for this walkthrough.

1. Configure a VM with distinct runtime and workspace storage sizes. Save it.
   Creation produces a stopped VM with separate root and `/workspace` disks.
2. Start it, then stop it. The displayed state must follow the runtime result.
   A failure must remain visible; it must not become Stopped or Running by default.
3. During onboarding, set a Git name/email and finish. These are saved to the
   VM's environment and verified before completion. Application preferences
   persist after quitting and reopening Silo.
4. CPU/RAM limits come from the host. Unknown measurements fail explicitly.
   Startup memory pressure uses the approved advisory; it is not an invented
   universal minimum. Disk failures report the real operation error.

GitHub authentication, repository cloning/pushing and other unimplemented
workspace tools remain separate work. Their actions return explicit errors;
empty lists do not pretend that discovery or synchronization succeeded.

## Backup

1. Open Backup, choose Create backup, select the disposable VM, then choose a
   destination through the native folder picker.
2. For a running VM, confirm Stop and back up. Watch the existing progress card:
   stopping, capturing storage, restarting and verifying the archive.
3. Success must name a real archive in the chosen folder. Previously running VMs
   should run again. A restart failure must preserve the valid archive and show
   Retry start; recovery succeeds only after the VM is confirmed Running.
4. Quit and reopen Silo. The completed archive and chosen destination remain.
5. Start another backup and cancel while it is copying. Confirm cancellation.
   Incomplete output is removed; previous completed archives stay intact.
6. An unavailable or full destination must show an error, not success. Unknown
   required space is omitted rather than estimated from compressed archive size.

## Restore and the new selector

1. Choose Restore and select the actual backup file through the native picker.
2. Review its contents. A multi-VM archive offers a compact VM selector. Changing
   it updates the suggested `<source>-restored` name; a name you typed is retained.
3. Enter a new name and restore. An existing name must be rejected without
   changing that VM. An invalid archive must fail before creating a VM.
4. The result is a new stopped VM. Start it and confirm both root and `/workspace`
   files survived. Configured storage sizes and Git identity must also survive.
   Running programs and unsaved memory are not restored.
5. The source VM and prior archives remain intact. Cancelling a restore removes
   only its newly owned partial VM and disk, never another same-name VM.

## Automated live regression

The ignored Rust test
`real_backup_restore_preserves_root_and_workspace_without_original_cache` uses
production create, identity, backup and restore functions with disposable paths.
It requires the built app and a working host hypervisor. Use the bundled runtime,
which Tauri signs with the Hypervisor entitlement; the raw build-cache executable
cannot boot a macOS VM:

```sh
SILO_TEST_MSB="$PWD/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/MacOS/msb" \
SILO_TEST_LIBKRUNFW="$PWD/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/Frameworks/libkrunfw.5.dylib" \
cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml \
  real_backup_restore_preserves_root_and_workspace_without_original_cache \
  -- --ignored --nocapture
```

These variables exist only in the compiled test harness, not the application.
The test writes distinct root/workspace markers, backs up, and deletes the
isolated original runtime/cache/volumes. It restores into different runtime
homes, first empty and then already containing an independently created VM.
It starts restored VMs, verifies files and identity, and checks that the existing
VM and its cached disks remain intact. It cleans up its own VMs. It never uses existing user VM data.

## Coverage limits

macOS is the available live verification host. Unit tests cover failure mapping,
archive traversal/integrity, cancellation, name collisions and resource handling.
Linux code and packaging inputs are covered by source and focused tests, but
neither Linux architecture is live-qualified on this Mac. Run the same real
create/backup/restore flow on supported arm64 and x86_64 Linux before release.
An ad-hoc debug signature is not notarization or release-signing verification.

## Recorded evidence, 2026-09-08

The production `Silo.app` built successfully and passed
`codesign --verify --deep --strict`. In its native window, accessibility checks
observed `macOS 26.5 · Apple silicon`, `Apple Hypervisor available`,
`Bundled msb 0.6.17 · libkrunfw 5.6.1`, `Bundled Git 2.53.0`, and
`Bundled Git LFS 3.7.1`; Continue was enabled. Both disclosures expanded and their
normal captions remained one line. The window screenshot is generated evidence
at `app/SiloUI/src-tauri/target/ui-evidence/dependencies.png`.
The app was closed through **Silo > Quit Silo**; a subsequent process query found
no `silo-ui` or `silo-preview` process. No test mode was used.

The frontend suite passed 412 tests in 46 files. The production web build,
typecheck and lint passed. The native suite passed 92 tests with the real-VM test run separately; Rust
format checks passed. Live VM evidence is recorded after the end-to-end run
below.

A separate generated copy had its real runtime manifest removed and was signed
again. It still opened Dependencies, reported the exact missing file, marked
MicroSandbox unsuccessful and disabled Continue. Retry repeated the real check
and remained failed. Screenshot: `src-tauri/target/ui-evidence/dependencies-missing-runtime.png`.
No production files or ordinary app settings were changed for that failure test.

The final signed runtime passed the expanded portable regression in 41.52 seconds,
without a preparatory image pull. Both creations remained stopped. After backup,
the test removed both originals and their entire cache, restored with image
pulling disabled into a different empty home, then repeated restore in a third
home containing an independently created VM. Restored root/workspace files,
Git identity and separate configured filesystems survived. Existing cached VMDKs
remained byte-identical and the existing VM still booted. All disposable test VMs
were cleaned up. A real two-VM archive is retained as ignored evidence at
`src-tauri/target/ui-evidence/verified-root-workspace.silo-backup`.

The native archive picker opened the real two-VM archive. `Sandbox to restore`
listed both sources; selecting `silo-proof-second` changed the suggested name to
`silo-proof-second-restored`. The compact production selector is captured at
`src-tauri/target/ui-evidence/restore-selector.jpg`. The native destination picker
also returned the selected folder and enabled Review backup. These used the same
production code in a separate `org.silo.verification` application identity, with
real disposable VM data and no fixture mode.

The final desktop walkthrough restored `silo-proof-backup-restored` alongside an
existing real VM. The result card showed **Restore complete**. Sandboxes showed
**Stopped**, then **Running** after Start, then **Stopped** after Stop. Creating
a backup of that restored VM showed **Backup complete** and produced
`Silo-Backup-1788886343.silo-backup`. After Quit and relaunch, Recent backups still
listed that archive with its source and destination. Screenshots:
`src-tauri/target/ui-evidence/restore-complete.jpg`, `backup-complete.jpg`, and
`backup-history.jpg`. The verification app was closed through its Quit menu.

The walkthrough also caught and fixed two desktop boundaries: native dialogs
must run off the main thread, and Rust enum fields must serialize using the same
names expected by TypeScript. Shared native/frontend contract tests cover idle,
running and completed backup payloads. Failed state reads retain an explicit
operation error rather than hiding the outcome.

## Continue and the setup queue

1. Reopen a saved draft on Sandboxes. Before submission, the footer says
   **Not started**, and the draft determines the operation count. Merely opening
   the app does not create its VMs.
2. Click Continue. The exact displayed configuration enters the queue and starts.
   Returning and clicking Continue again must not duplicate an identical job.
3. During creation, the Sandboxes panel shows the actual VM and operation, an
   elapsed timer and native activity. Navigation remains responsive.
4. Continue from GitHub submits the selected identities after VM creation.
   Review shows submitted work running/waiting, with unsubmitted work labelled
   **Not started**. Finish persists completion only after prerequisites succeed.
5. A failed request keeps its error and Retry. The failed VM must not retain an
   In progress badge. Retry uses the latest submitted draft. Quit waits for
   submitted native work before completing the settings shutdown handshake.

The isolated native walkthrough observed actual creation progress, responsive
Continue, identity work waiting behind creation, and disabled Finish. The live
image download timed out; Retry then returned a Docker registry connection
error. Both outcomes were displayed without success. Queue ordering, duplicate
submission, retry, stale-result handling and shutdown use deterministic deferred
bridge regressions; no fixture launch mode was added to the application.

Final queue verification: 425 frontend tests in 49 files passed with
`npm --prefix app/SiloUI test -- --maxWorkers=1 --testTimeout=30000`;
typecheck and lint passed. Parallel runs hit the existing five-second UI-test
deadlines, so the final run used one worker and a larger runner deadline without
changing assertions or test configuration. The 28 focused native runtime tests
and 15 settings lifecycle tests passed. The production desktop bundle built and
passed signature verification.

After reopening the rebuilt production app, the existing three-VM draft showed
**Not started · Continue to start this step**, **Continue to create sandboxes**,
and **0 of 6 operations complete**. The user's draft was not submitted during
verification. Screenshot: `src-tauri/target/ui-evidence/setup-draft-idle.jpg`.
