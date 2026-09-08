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
   Review shows status on each sandbox and the Git author card, with unsubmitted
   work labelled **Not started**. There is no separate Setup operations list.
   Finish persists completion only after prerequisites succeed.
5. A failed request keeps its error and Retry. The failed VM must not retain an
   In progress badge. Retry uses the latest submitted draft. Quit waits for
   submitted native work before completing the settings shutdown handshake.

To check optional GitHub setup, leave GitHub disconnected and continue to Review.
Saved repository choices remain in the draft but are excluded from submission
until GitHub is connected. Git author choices still apply. Click Finish: setup
must complete without a repository-setup error. Connected repository selections
still fail explicitly because repository setup is not implemented.

On Review, each verified sandbox must show **Complete**, matching its Sandboxes
row. Git author shows **Complete** only after saving and verification succeed;
pending and failed work retain their actual status. Errors may wrap, while
normal card captions remain one line. Use Edit to return to each source step
and confirm the same status after returning to Review.

Native verification of the inline Review status used the rebuilt production
`src-tauri/target/debug/bundle/macos/Silo.app`. Review showed dev, playgrounds,
and personal as Complete; GitHub access was not connected and Git author was
Not started. Clicking Finish applied the saved identity and opened the main
Sandboxes screen without error; all three VMs remained Stopped. The app was
left open. Screenshots are in the ignored `src-tauri/target/ui-evidence/`
directory: `review-inline-validation.jpg` and `review-finish-disconnected.jpg`.

## Live activity

1. Open onboarding's Sandboxes step and expand Live activity. After restarting
   Silo, it displays the latest recorded attempt; it does not rerun setup.
2. Continue with existing sandboxes. Return to Sandboxes: activity must include
   timestamped verification for each VM and an explicit completed outcome.
3. When adding a VM, activity must identify disk preparation, image resolution,
   download, image checks/preparation, configuration saving and verification.
   Downloaded bytes are real; a total is shown only when every layer size is
   known. Cached images need not produce a download. A quiet create reports its
   last stage and elapsed time every five seconds.
4. An actual failure must end with an error, affected VM and recovery guidance.
   Warnings represent nonfatal conditions. Copy activity must copy the same safe
   text shown on screen, without raw registry URLs, credentials or host paths.
5. Quit and relaunch. The recorded outcome and diagnostics remain available.
   A recorded unfinished attempt is labelled interrupted, never completed.
   A history read/write failure is explicit and does not invent history.

Do not interrupt a user's VM operation merely to produce a screenshot. Native
tests cover interrupted/corrupt histories, missing storage, safe failure
categories, streamed output and exit-event delivery. Tests use temporary storage;
there is no production fixture switch or debug activity feed.

Verified on macOS with the rebuilt production bundle: Continue verified all
three existing VMs, activity showed timestamped start/verification/completion,
and the same attempt reappeared after a normal quit/relaunch. Onboarding remains
open with Live activity expanded. Screenshots: `activity-completed.jpg` and
`activity-retained.jpg` under the ignored `src-tauri/target/ui-evidence/` folder.
No user VM was started. A separate disposable runtime check downloaded a fresh
BusyBox image and created a stopped sandbox successfully, reporting 266,867 then
1,900,727 bytes against a 1,900,727-byte total; temporary storage was removed.

Validation: the full frontend suite passed 442 tests before two final boundary
regressions were added; the final affected bridge/panel suite passed all 30
tests. All 37 native runtime tests passed, including the local socket test.
Three tests extracted verbatim from the patched upstream encoder passed.
Typecheck, lint, desktop bundling and signature verification passed. Linux
native execution was not tested on this macOS host.

## Host Git and jj identity

### Automatic startup and notifications

Use the existing completion screen or Settings controls; there is no test mode
or extra production control for these features.

1. With onboarding complete, enable Start sandboxes at launch and select a local
   VM. Quit Silo normally and reopen it. Only selected local VMs should start;
   already-running VMs must not restart. Opening/closing the status panel,
   focusing the main window or refreshing state must not start them again.
2. Disable automatic startup and relaunch. Stopped VMs must stay stopped.
   Incomplete onboarding must never trigger automatic startup. Missing or remote
   selections must not create a replacement VM or be reported as started.
3. Enable notifications and the desired categories through the existing UI.
   When the OS already grants permission, genuine state changes and failures
   should produce the corresponding notifications. Opening Silo must not announce
   every VM's initial state; repeated reads must not duplicate an alert.
4. Disable all notifications or an individual category and repeat the relevant
   event. That category must remain silent. Denied OS permission must not trigger
   an automatic permission prompt. Use the existing Enable notifications control
   to request permission deliberately.
5. Failure tests use isolated runtime and delivery seams for startup, actions,
   health reads and backup results. Do not corrupt user data to manufacture an
   alert. Notification text must not include raw command output, credentials or
   archive paths. A notification delivery failure must not undo a successful
   sandbox operation or backup.

Native verification on 2026-09-09 used the normal production debug bundle,
`src-tauri/target/debug/bundle/macos/Silo.app`, with saved startup selections dev
and playgrounds. The first attempt exposed a Created/Stopped mapping bug; a
failing regression and fix added support for newly prepared Created VMs. The
rebuilt app automatically started dev and playgrounds; personal stayed Stopped.
The existing Stop dev and Stop playgrounds controls then returned both to Stopped.
The final app remains open and startup preferences remain unchanged.

Notification policy, initial-state suppression, health transitions and OS
authorization were tested natively; the real startup failure exercised the
action-failure hook. Visible OS notification delivery was not verified: automatic
approval review rejected Notification Center inspection because it could expose
unrelated private notifications. Linux delivery was not exercised on a Linux
desktop. Native tests passed, including a Unix-socket test rerun outside the
restricted sandbox, plus the final four Created/Stopped startup regressions.
TypeScript build, lint, native bundle build and strict signature verification
passed. The build log is `/tmp/silo-startup-notifications-build.log`.

### Resume, retry and completion

1. Apply the Git author on GitHub, then open Review and confirm **Complete**.
   Quit and reopen Silo before finishing onboarding. The same author must regain
   **Complete** after a read-only check of the saved VM configuration. Opening
   onboarding must not create a VM or rewrite its identity.
2. Change an author without submitting it. Review must not claim that the new
   value is complete. Continue applies and verifies that value normally.
3. Regression tests cover failed sandbox submissions, failed identity submissions
   and failed final settings saves. **Retry** must repeat the failed submission,
   not replace it with sandbox configuration. Do not damage a real installation
   or change host permissions to manufacture these failures manually.
4. Leave GitHub disconnected and click **Finish**. After the settings save
   succeeds, the existing **Setup complete** screen must remain visible with
   login and notification options. **Open Silo** enters the main app.
5. Quit and reopen after successful completion. Silo must open the main app
   directly. Failed completion must leave onboarding open with its error.

Dependency checks retain their existing Retry checks and reinstall guidance;
this flow does not download replacement app components.

### Dependency recovery

Missing or damaged bundled files explain how to reinstall from the original
download or package manager while keeping app data. Host failures give the
specific OS, architecture or Linux KVM requirement. Timeouts and bridge failures
offer Retry checks, then reopening Silo, without claiming reinstall is needed.
The main app exposes the same checks through its existing System issue or load
error display. Retry checks becomes disabled Checking… while running, retains
the error instructions and removes the issue only when checks pass. There is no
Repair action, simulated repair progress or simulated success banner.

Native verification on 2026-09-09 used a temporary copy of the production debug
bundle with only its bundled msb removed. The load error displayed missing-file
and reinstall guidance plus Retry checks. Restoring that file in the copy and
clicking Retry checks returned to the real sandbox list without restarting the
app; all three VMs stayed Stopped. The normal bundle was not damaged and no VM
configuration changed. The temporary app was quit and removed. Regression tests
cover retained guidance during checking and clearing it after success. Eight
native dependency tests cover platform/error mapping; Linux was not tested live.

Native verification on 2026-09-09 used the rebuilt production debug bundle at
`src-tauri/target/debug/bundle/macos/Silo.app`. Before the fix, quitting and
reopening changed Git author from Complete to Not started. After the fix,
reopening restored Complete without submission. Finish with GitHub disconnected
showed Setup complete, the login/notification controls and Open Silo. Open Silo
entered Sandboxes; quitting and reopening entered Sandboxes directly. All three
VMs remained Stopped. The final instance was left open. Retry failure paths were
covered by component/source regression tests, not manufactured against live data.
The 461-test frontend suite, focused native identity regression, TypeScript,
lint, debug bundle build and strict signature verification passed. Build/test
logs for this run are `/tmp/silo-onboarding-fixes-build.log` and
`/tmp/silo-onboarding-fixes-tests.log`.

Open GitHub in onboarding: untouched author fields should use the configured
host Git name/email, or a complete jj pair if Git has none. Without either,
fields remain empty and manual entry remains available. Edit one sandbox's
identity and navigate away/back: it must retain that edit. Reset uses the
detected host pair. Continue applies/verifies Git and jj identity variables in
stopped VMs; the host configuration is read-only.

Native verification replaced the old example draft with the detected Git author
and applied it successfully to all three existing stopped sandboxes. Review
showed Git author Complete; GitHub remained disconnected. No VM was started and
onboarding remains open. Eight native identity tests, 68 focused frontend tests,
and the final 20 bridge/recovery tests passed; typecheck, lint, bundle build and
signature verification passed. jj fallback uses isolated regression tests;
the real-app walkthrough used Git.

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
