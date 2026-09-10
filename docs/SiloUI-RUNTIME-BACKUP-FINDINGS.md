# SiloUI runtime and backup decisions

Validated against MicroSandbox 0.6.17, source commit
[`5eca4de8bf233e57f114140f8c076ea8c96f21ab`](https://github.com/superradcompany/microsandbox/tree/5eca4de8bf233e57f114140f8c076ea8c96f21ab).
The old Swift app and shell scripts are reference material only.

## Bundled runtime

Silo bundles MicroSandbox, libkrunfw, Git and Git LFS. Backup compression and
archive reading are compiled into Silo and MicroSandbox; users need no `tar`,
`gtar` or `zstd` commands. Git LFS supports repositories that use LFS; it is not
used for VM backups or Git identity. Guest tools belong to the VM image.

Tauri's [sidecar](https://v2.tauri.app/develop/sidecar/) and
[resource](https://v2.tauri.app/develop/resources/) layouts determine packaged
paths. No host `msb` fallback is allowed. Source, patch, agent, library and build
inputs are pinned by the preparation script and recorded in its manifest.
On macOS, Tauri signs the runtime sidecar with the Hypervisor entitlement.
The existing ad-hoc debug build disables hardened runtime because ad-hoc
components have no Team ID for library validation. Release builds retain
hardened runtime and require matching Developer ID signatures. This is a
[build configuration](https://v2.tauri.app/reference/config/#hardenedruntime),
not a runtime UI or fixture switch.
A nested source checkout must have its own Git repository before applying the
patch: otherwise Git can silently skip patch paths. A regression covers this.

The upstream CLI only offered `run --from-snapshot`, which starts guest programs.
The checked-in patch adds `create --from-snapshot`, using the existing SDK
snapshot preparation with startup disabled. It persists the Created state,
retains root-disk capacity, and permits cleanup without pretending a guest ran.
Silo also uses an explicit `create --no-start` flag for new image-based VMs.
Creation and restore therefore leave VMs stopped; neither boots guest programs
just to prepare storage or apply Git identity.

The pinned [image client](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/image/lib/registry/client.rs#L577)
also reserialized OCI manifest JSON while retaining the
original content digest. A live backup/restore test caught the mismatch after
deleting the source cache. The patch fetches original bytes by the resolved
digest, verifies them and preserves them. Snapshot export also validates cached
metadata before publication, so older malformed cache entries cannot produce a
new unusable archive. Integrity validation is never relaxed.

Silo retains the existing internal application identifier to preserve settings,
VM data, permissions and login registration. The visible application name is
Silo. Native entry points have no fixture queries or test environment overrides.
Fixtures remain reachable only from tests and explicit preview modules.

Silo uses a verified, private short symlink for `MSB_HOME` so macOS Unix socket
paths fit their 103-byte limit. The actual VM data stays in Application Support.
The alias is unique to the app data directory; existing unrelated paths are
rejected. The default Ubuntu image uses the explicit Docker registry hostname
(`registry-1.docker.io/library/ubuntu:24.04`), which was used for the live test.
Transient registry delays remain bounded operation failures; they do not justify
a special cache or credential workaround.

## Storage and resource limits

Each VM has a managed OCI root disk sized by **runtime storage** and a separate
ext4 disk at `/workspace` sized by **workspace storage**. Both capacities are
real, independent limits. Creation formats the workspace disk using the pinned
Rust filesystem library; it needs no host formatting command.

Silo uses actual host CPU and RAM capacity for configuration limits and reports
unavailable measurements as errors. Startup pressure is advisory. There is no
arbitrary global RAM/disk minimum. Compressed backup size cannot predict restore
space reliably, so unknown estimates are omitted. Write failures, including a
full destination, fail the operation and trigger cleanup.

## Backup and restore

The pinned [snapshot contract](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/docs/sdk/typescript/snapshots.mdx)
requires stopped VMs and captures disk state, not memory or running programs.
Silo stops selected running VMs, captures root and workspace storage plus VM
configuration, then attempts to restart those previously running. Restart failure
is reported separately from archive success.

The pinned [snapshot archive implementation](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/snapshot/archive.rs)
provides sparse-aware compressed root snapshots. Silo includes image content and
parents, plus its own verified workspace volume members, so restore does not
depend on the original cache. Archive members, hashes, paths and configuration
are validated before publication or restore. Unsupported external mounts and
runtime settings must fail instead of being silently omitted.

Archives publish atomically without replacing an existing file. Cancellation
removes temporary output. Restore asks which VM to restore from a multi-VM
archive, validates the new name, and creates a new stopped VM. Existing VMs are
never restore targets. Archives record guest CPU architecture; a different or
unsupported CPU architecture is rejected before restore. Same-architecture
macOS/Linux transfers are not blocked by OS name. Root and workspace capacity and saved identity survive.
Completed archive history and the last destination persist atomically in
application data. A corrupt history file is preserved and reported; it never
turns into an empty successful history. Native file selection uses the [Tauri dialog plugin](https://v2.tauri.app/plugin/dialog/).

Git identity uses the pinned [`modify --env` command](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/cli/lib/commands/modify.rs)
to persist Git author and committer environment variables, then reads them back.
This requires neither booting the VM nor installing Git inside it. Repository
cloning and GitHub authentication are separate work; unimplemented requests
cannot report completion.

See [the real-app testing guide](SiloUI-DEPENDENCIES-BACKUP-TESTING.md) for commands,
observed evidence and platform limits.

## Native picker threading

The native walkthrough reproduced a main-thread deadlock in the synchronous
backup picker commands. Both now follow the existing application picker pattern:
an async Tauri command runs the blocking dialog and subsequent file work through
`spawn_blocking`. The [dialog API documentation](https://docs.rs/tauri-plugin-dialog/2.7.3/tauri_plugin_dialog/struct.FileDialogBuilder.html#method.blocking_pick_file)
explicitly prohibits calling blocking pickers on the main thread.

## Portable image descriptors

The native restore walkthrough found that upstream archived VMDK descriptors
contain absolute source-host paths. Importing them verbatim either conflicts
with the destination's descriptor for the same image or retains unusable paths.
The [upstream descriptor writer](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/image/lib/stitch/vmdk.rs)
confirms those paths are canonicalized during image conversion. Restore must
rebuild the descriptor from validated image extents at destination paths, while
retaining integrity checks for the underlying image content and never replacing
files used by an existing VM. Live verification uses different source and
destination runtime homes to expose this portability boundary.

Cache publication also uses atomic no-overwrite installation. If another process
publishes the destination first, import verifies its content and retains it;
it never replaces that file. Five focused upstream archive tests cover the
relocated descriptor, existing descriptor preservation, and publication races.

## Setup submission and progress

A saved onboarding draft is not a submitted runtime operation. Continue on
Sandboxes submits that exact configuration; Continue on GitHub submits identity
work after its machine configuration. Equal submissions reuse the same job.
Changed submissions run in order, and an older completion cannot hide later
queued work. Unsupported repository setup fails explicitly before changing VMs.
Finish queues final settings persistence after its prerequisites succeed.

The production source exposes explicit idle, queued, running, succeeded and
failed states. Native configuration emits correlated per-VM events immediately
before and after actual configuration, verification and removal. A completed
verification event cannot be emitted after an error. These native commands and
state reads run off the UI thread using Tauri's existing blocking-worker pattern.
The settings shutdown handshake drains submitted setup jobs before exiting.
No setup work starts merely because a saved draft is rendered or reopened.

## Setup activity and retained diagnostics

MicroSandbox's [typed image progress](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/image/lib/progress.rs)
already reports layer bytes and preparation stages, but its
[CLI renderer](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/cli/lib/ui.rs)
hides progress when stderr is not a terminal. Silo now bundles a narrow
`create --progress-json` patch: allowlisted stage names and numeric counts go to
stderr; normal JSON command results remain on stdout. No image URL, digest,
credential or host path is included. Byte updates are throttled to one per
second while phase boundaries and completion are retained. A total is exposed
only when all layer sizes are known. Completed bytes never establish VM success.

The native setup runner consumes that stream, records disk/configuration checks,
and sends small updates through the existing
[Tauri event mechanism](https://v2.tauri.app/develop/calling-frontend/).
Quiet creates repeat the last real stage with elapsed time every five seconds.
Errors include the failing VM, a safe reason and recovery guidance; runtime
exit codes are retained. Unknown raw stderr is not copied to the activity panel.
Warnings cover actual unavailable memory checks and activity-storage failures.

The latest attempt is written atomically to `setup-activity.json` beside runtime
metadata, with a private file mode and a bounded history. Reads validate and
reconstruct display text from trusted event types. A nonterminal attempt is
marked interrupted after restart. The frontend keeps this history separate from
current progress, loads it at launch and after command completion, and rejects
history from a different attempt when a current command finishes. A failure
before native activity storage opens still receives an explicit in-session
failure message. Copy uses the same filtered text shown in the existing panel.

## Host author defaults

Production reads a complete name/email pair from the installed Git using
[`git config --global --includes --get`](https://git-scm.com/docs/git-config).
This respects user configuration and included files without borrowing the app
checkout's repository identity. If either value is unavailable, it reads a
complete pair through [`jj config get`](https://docs.jj-vcs.dev/latest/config/).
It never combines fields from different tools or guesses from the login name.
Both reads run outside a repository, have bounded output and a two-second
timeout, and never change host configuration. Missing/failed reads leave manual
entry available. GUI executable lookup includes standard user and Homebrew
installation directories.

Onboarding fills only untouched empty identities when host detection arrives;
manual edits and disabled Apply choices remain intact. Mutation responses that
omit host identity retain the detected value until the next authoritative read.
The existing sandbox identity action also sets and verifies `JJ_USER` and
`JJ_EMAIL`, the [Jujutsu identity environment variables](https://docs.jj-vcs.dev/latest/cli-reference/#jj-metaedit),
alongside Git author/committer values. This does not install jj or change the
host's Git/jj configuration. Example identities remain isolated to fixtures;
there is no production fallback name or email.

## Dependency recovery (2026-09-09)

Dependency checks remain read-only. Missing, incompatible or damaged bundled
components direct the user to reinstall Silo through the original download or
package manager while keeping app data. `RuntimePaths` stores VM data under
Tauri's app data directory, separate from bundled executables and resources;
settings use that same app data directory. Replacing app files does not require
removing either data directory. No automatic download, repair or privilege
change is introduced.

Timeouts, bridge failures and unavailable probes offer Retry checks, followed by
quitting and reopening Silo if the failure repeats. They do not prove package
damage and must not recommend reinstalling. Unreadable bundled files explain
read/run permissions. A skipped Git LFS check directs the user to the preceding
Git failure rather than inventing a second diagnosis.

Host failures describe the host action: update an unsupported OS/distribution,
enable virtualization/KVM, or grant the current user access to `/dev/kvm` and
sign out and back in. Linux uses a read/write device open plus
`KVM_GET_API_VERSION`, never VM creation. The [kernel API documentation](https://docs.kernel.org/virt/kvm/api.html)
requires API 12. [Ubuntu's virtualization documentation](https://ubuntu.com/server/docs/how-to/virtualisation/libvirt/)
confirms that hardware virtualization can require enabling in firmware settings.
These are host requirements, so reinstalling Silo cannot resolve them. Commands
that change groups or install distribution packages are intentionally not guessed
across all Linux distributions.

Focused checks: `npm test -- src/desktop/dependencies.test.ts` and
`cargo test --manifest-path src-tauri/Cargo.toml dependencies::tests` from
`app/SiloUI`. Native tests cover missing/damaged bundles, transient probes,
old glibc, missing KVM and denied KVM access; store tests verify bridge and timeout
recovery never recommends reinstalling. Linux failure mappings run as pure tests
on macOS; this is not live Linux hardware verification.

## Start selected sandboxes when Silo launches (2026-09-09)

Native app setup starts a blocking worker once per process. It reads the same
validated persisted settings store as the UI and requires both completed
onboarding and the enabled startup preference. It uses only the saved selected
IDs, once each, in saved order. An empty selection starts nothing. Refreshing or
reopening a webview cannot repeat startup: Tauri's [`Builder::setup`](https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.setup)
accepts a `FnOnce` hook on the native app builder, unlike a webview page-load hook.

Each selected local VM must already exist and belong to Silo. Running VMs are
left running; stopped VMs use the existing lifecycle resource checks and start
command, then are inspected to verify Running. Missing, SSH, inconsistent, or
failed selections do not create or repair anything. Remaining selections are
still attempted, and one existing error dialog lists failures, even if system
notifications are disabled. Real state refreshes after each attempt.

Quit cancels remaining selections and waits for the current bounded native start
before exit. Startup does not alter the saved preference or selected IDs. Tests
use temporary metadata and a fake process runner, never a user's VMs. Focused
checks: `cargo test --manifest-path src-tauri/Cargo.toml launch_` and
`cargo test --manifest-path src-tauri/Cargo.toml startup::tests` from `app/SiloUI`.

## Native notifications (2026-09-09)

Existing notification preferences now gate real native delivery. `notificationsEnabled`
controls all categories; `notifyHealth`, `notifyActions`, and `notifyBackup` retain
existing default-true behavior when absent from the settings document. Explicit
false disables that category. Unreadable/protected settings fail closed. Delivery
never requests permission, changes preferences, or changes an operation's result.

- macOS uses the existing UserNotifications framework, checks authorization before
  each request, and submits only for authorized/provisional states. A retained
  delegate permits foreground banners/list entries; macOS settings and Focus still
  determine presentation. Delivery errors produce a generic application log line.
- Linux uses the existing GIO session-bus connection to
  `org.freedesktop.Notifications.Notify`, a five-second delivery timeout, and the
  app's desktop-entry hint. No shell command or extra executable is needed. The
  notification daemon controls desktop policy and suppression; the standard does
  not expose per-application permission authorization or a standard permission prompt.
- Sandbox action, identity setup, and sandbox configuration failures notify once
  from the command's final result, including failures before work begins. Startup
  failures use the same action category. There is no cooldown that hides a distinct
  failed retry. Notifications contain fixed safe recovery text, never raw errors,
  paths, credentials, or Git author values.
- Backup and restore report failed results and backup restart-required results.
  Explicit cancellation and successful backup/restore results remain silent.
- A background thread inspects real local sandbox state every 30 seconds with a
  five-second total command budget. It never holds the mutation lock during reads,
  skips active mutations, and discards reads if a mutation remains active or saved
  metadata changed. It does not start VMs. Existing runtime paths must already exist.
  The first observation and newly discovered sandbox baselines are silent; subsequent
  actual state/health-check transitions produce one grouped notification with up to
  three validated sandbox names and states. Unchanged observations do not repeat.
  Remote SSH placeholders are excluded. Disabling notifications still advances the
  baseline, so reenabling does not replay old problems.

Primary references:

- [Apple: asking permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)
- [Apple: handling foreground notifications](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions)
- [Freedesktop notification protocol](https://specifications.freedesktop.org/notification/latest-single/)
- [Freedesktop desktop-entry hint](https://specifications.freedesktop.org/notification/latest/hints.html)

Native policy tests cover master/category preferences, denied/unknown permission
states, silent first/unchanged/new-sandbox observations, actual state transitions,
bounded grouped messages, and backup failure/partial-restart/cancellation routing.
No test sends a synthetic OS notification or changes the user's notification settings.
Linux delivery requires live Linux desktop verification; the current host is macOS.

Startup recognizes MicroSandbox `Created` as an existing, startable VM as well as
`Stopped`. The pinned [sandbox status enum](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/db/lib/entity/sandbox.rs)
defines `Created` as created but not yet started; Silo's `--no-start` preparation
uses this state and displays it as Stopped. Crashed VMs require a manual start;
launch does not perform automatic crash recovery. The startup regression covers
both Created and Stopped before verifying Running.


GitHub access now has a separate [implementation plan](SiloUI-GITHUB-IMPLEMENTATION.md).
The previous GitHub transport proposals were removed.

## Existing VM edits (2026-09-09)

Existing VM names and both disk sizes remain visible but cannot be edited.
Storage fields explain on hover or keyboard focus: “To use a different disk
size, create a new VM and transfer your data.” New and duplicated configurations
retain editable names and storage. Completed onboarding VM rows use the same
restrictions.

CPU and memory limits/ceilings remain editable. A running VM's editor says
“Stop VM and save”. Native configuration updates stop a running VM, inspect it
again, and refuse to modify settings unless it is stopped. Saving does not start
it again. Existing rename and disk-size validation remains in the backend.

Verification: 126 focused frontend tests passed; 56 runtime tests passed in the
restricted environment, with the filesystem-alias test requiring a separate
permission-enabled run. Tests cover read-only fields and tooltips, creation and
duplication, resource edits preserving GitHub settings, stop-before-modify ordering,
and no settings mutation when stopping cannot be verified.

The filesystem-alias test passed with its required filesystem permission, bringing
runtime coverage to 57 passing tests. The rebuilt production macOS app showed the
name without edit capability, both storage controls disabled, unchanged CPU/RAM
controls, and the explanatory tooltip on keyboard focus. No real VM settings were
changed during this UI check; the running-VM stop/save path has automated coverage.

## Interrupted backup and restore (2026-09-10)

A private, atomically replaced `backup-operation.json` records the confirmed
request before work starts. It stores the archive path, sandbox identities,
previously running guests, restore ownership, cancellation and final result.
No credential material belongs in this journal. Unreadable or newer journals are
preserved and disable backup actions instead of guessing that work succeeded.

Relaunch displays the existing progress card while checking the checkpoint.
Backup recovery restores previously running guests using current GitHub/secret
settings, verifies an already published archive, or restarts the capture/copy.
Restore recovery accepts a committed VM only after checking its exact machine ID,
state and disks. Incomplete storage is removed only when its durable owner marker
matches the saved operation; restore then replays from the verified archive.
Cancellation is durable and completes recovery/cleanup instead of replaying work.
Copying restarts from the beginning; this is not byte-offset resumption.

Scratch cleanup is confined to Silo's private working directory. Incomplete
archive files include the journal's random operation UUID, so recovery removes
only that operation's files, never earlier backups or another operation's files.
Restore owner markers are removed and their parent directory synced after commit.
Completed results survive relaunch until dismissed; delayed dismissal carries the
exact result and cannot erase a later operation.

Stop, snapshot and stopped-create commands inherit an OS file lock. Recovery waits for
that lock with a bounded timeout before reading or removing their output, even
when the original app process was killed. Start commands do not inherit the lock,
because their VM daemon intentionally survives. These are documented
[macOS flock semantics](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)
and [Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html).
The bundled MicroSandbox patch makes `create --from-snapshot` stop before boot;
this is the only create form the backup service uses.

Startup waits for pending backup recovery before configuration/lifecycle recovery
and optional automatic starts. Waiting for another sandbox mutation is
cancellable. If cleanup cannot prove ownership or finish safely, the journal stays
pending, Backup actions are unavailable, and the existing error card explains
that relaunch will retry; dismissing a message cannot discard that checkpoint.

### Standalone VM actions after app interruption (2026-09-10)

Start, Stop and Restart now save the exact Silo VM ID, requested action, phase and
original activity event before running the command. Journals are per VM so a
failed request does not block unrelated sandboxes. Recovery verifies both saved
metadata and the runtime's `silo.machine-id`; it does not act on a replacement
that reused a name. Successful deletion retires only that VM's pending action.

Restart is a verified Stop followed by a persisted Start phase. Exiting after
Stop resumes Start; exiting after Start verifies the already-running VM instead
of restarting again. A failed Stop is not successful just because a VM crashed.
The existing activity entry is updated when recovery completes. Explicit Stops
recovered during launch are excluded from automatic starts for that launch.

Startup waits for backup/restore recovery, then configuration recovery, then VM
action recovery, before applying normal automatic-start preferences. No new UI
was added. Pending work uses existing status, activity and error surfaces.

The pinned MicroSandbox [local Start implementation](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/backend/local/sandbox/mod.rs)
serializes detached starts with its transition guard, database state claim and
runtime lifecycle lock. Silo waits for transitional states and rechecks identity
and terminal state even if a surviving start wins a duplicate command. It does
not pass Silo's configuration-worker lock into detached Start, where the daemon
could retain it indefinitely. An outside program deliberately stopping/starting
the same VM before a pending Stop checkpoint is reconciled is outside exactly-once
guarantees: the saved desired state is enforced again.

Proof: the opt-in `lifecycle_recovery_survives_real_worker_exit_without_repeating_restart`
passed in 9.35 seconds on macOS. Isolated worker processes exited after real Stop
and Start commands, without the next journal checkpoint. Boot IDs proved one
recovered restart and no repeated completed restart or surviving detached Start.
The test also verified recovered Stop exclusion and removed its disposable VM.
Focused tests cover each checkpoint, repeated recovery, failed-start retry,
replacement preservation, activity reuse and superseded actions.

### Integrated macOS verification (2026-09-10)

The final native suite passed 285 tests plus 5 build-configuration tests; 10
opt-in tests were excluded from that default run. The frontend passed 609 tests
in 65 files. Type checking and lint also passed. The separate real backup,
lifecycle and synthetic GitHub proofs above exercised the packaged runtime;
they do not prove authenticated GitHub account workflows.

`npm --prefix app/SiloUI run desktop:build:debug` rebuilt the canonical
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`. The previous app was
quit through its native menu before building. The rebuilt production app opened
with the existing `dev` VM stopped. Native UI checks confirmed the fixed-name and
disk explanation, a non-settable name field, both disabled disk controls, and
inline errors for VM port 65536 and local port 0. The unsaved forms were cancelled;
the VM and existing port settings were unchanged. The rebuilt app was left open.

Local logs: `/private/tmp/silo-recovery-final-native.log`,
`/private/tmp/silo-functional-final-ui.log`, and
`/private/tmp/silo-recovery-final-build.log`.
