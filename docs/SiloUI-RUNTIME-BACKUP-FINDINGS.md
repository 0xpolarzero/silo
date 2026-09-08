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
