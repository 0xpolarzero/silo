# Migrate an older VM to the silo account

Silo now requires the `silo` working account (UID/GID 1001). New VMs already have it. The migration script converts a standard older Silo VM with root-owned agent files and an optional `silo-desktop` account. Run it on the computer that owns the VM, with Silo closed and no other runtime commands running.

The script defaults to a dry run. Applying stops existing sessions, creates a root-disk snapshot and a separate workspace-disk backup, copies the existing home files into `/home/silo`, fixes their ownership, and installs passwordless sudo. It preserves agent credentials, relocates absolute home symlinks and launch scripts, and moves desktop configuration to the same account. The original home directories remain as backup copies. Missing Python, sudo, and SFTP packages are installed with apt, which requires guest network access in older images.

Only after guest verification and a clean stop does it save `silo.working-account=1` through `msb modify`. It leaves the VM stopped. The `silo-desktop` service name and `/var/lib/silo-desktop` state directory keep their names; they are not separate login accounts.

## Run

Use Python 3.11 or later and the `msb` and libkrunfw shipped together in Silo. Do not use an unrelated system installation. Supply the same runtime home Silo uses; its short alias is under `~/.silo/` and points into the app's `runtime/microsandbox` directory. For a remote computer, run these commands there against that computer's runtime.

From the repository root, replace the example paths and `VM_NAME`:

```sh
python3 app/SiloUI/scripts/migrate-working-account.py VM_NAME \
  --msb /Applications/Silo.app/Contents/MacOS/msb \
  --library /Applications/Silo.app/Contents/Frameworks/libkrunfw.5.dylib \
  --runtime-home "$HOME/.silo/RUNTIME_ALIAS"
```

After checking the selected name and plan, add `--apply --backup-dir /absolute/path/to/new-backup-directory`. The directory must not exist. Allow enough space for the root snapshot and a full copy of the workspace disk. Keep the backup private: it contains project files and credentials.

If an interrupted migration has already renamed the account, rerun with
`--apply --resume --backup-dir` pointing to its original backup. Resume verifies
backup identity, workspace size and snapshot integrity before continuing; it
does not replace the backup. Stale Unix sockets and named pipes are omitted
because their owning processes recreate them. Repeated home copies preserve
saved files and replace their migrated symlinks.

For a VM whose GitHub network profile requires `SILO_GITHUB` at boot, supply it
in the command's environment. A one-off noncredential placeholder is sufficient
for migration, which does not use GitHub; GitHub access is unavailable during
that boot. Silo supplies its normal credential on the next app-managed boot.

Start the VM in Silo afterward and check your agent authentication, project files, and desktop. This migration covers the standard Silo layout, not custom account arrangements or host-shared workspace mounts. Agent session histories and credentials are copied unchanged; a session history containing an old absolute working directory is not rewritten.

## Recover files from a backup

A failed migration leaves the VM without the new host label. Do not set that label by hand. The backup contains `root/` (a MicroSandbox snapshot), `workspace.raw`, the pre-migration `inspect.json`, and `workspace-source.txt`.

The root snapshot does **not** contain the attached workspace disk. Keep
`workspace.raw` with it. The snapshot depends on its base OCI image remaining
in this runtime's image cache. This is a local recovery backup, not a portable
VM export.

Create a separate recovery VM using both backed-up disks:

```sh
export MSB_HOME="$HOME/.silo/RUNTIME_ALIAS"
export MSB_BACKEND=local
export MSB_PATH=/Applications/Silo.app/Contents/MacOS/msb
export MSB_LIBKRUNFW_PATH=/Applications/Silo.app/Contents/Frameworks/libkrunfw.5.dylib
"$MSB_PATH" snapshot verify /absolute/path/to/backup/root
cp /absolute/path/to/backup/workspace.raw /absolute/path/to/recovery-workspace.raw
"$MSB_PATH" create --from-snapshot /absolute/path/to/backup/root \
  --name account-recovery --no-start \
  --mount-disk /absolute/path/to/recovery-workspace.raw:/workspace:format=raw,fstype=ext4
"$MSB_PATH" modify account-recovery --label-rm silo.managed --label-rm silo.machine-id
"$MSB_PATH" start account-recovery
"$MSB_PATH" exec account-recovery --no-start --user root -- /bin/bash
"$MSB_PATH" stop account-recovery
```

The recovery copy can require the workspace disk's full logical size; on Linux,
use `cp --sparse=always` to preserve holes, or on macOS use `cp -c` when the copy
stays on a filesystem that supports cloning.

Choose a recovery name that does not already exist. The mount override isolates recovery from the original workspace; the label removal prevents duplicate Silo machine identities. Recover files into a newly created Silo VM rather than manually editing Silo's machine registry. The original VM and backup remain available.

## Verification

Run `python3 -m unittest discover -s app/SiloUI/scripts -p test_migrate_working_account.py` for disposable file and orchestration tests. These verify dry-run behavior, failure ordering, credential preservation, and home-path relocation. They do not prove Linux account changes or a live desktop session.

Runtime commands were checked against Silo's bundled MicroSandbox 0.6.17 CLI (`modify --help`, `snapshot create --help`, `create --help`). The pinned runtime's `sdk/rust/lib/snapshot/create.rs` confirms snapshots cover the managed root upper layer; the migration therefore copies the workspace disk separately.

A disposable Ubuntu 24.04 ARM64 VM verified the actual account rename, UID/GID 1001, private credentials, desktop-home files, relocated executable symlink, writable workspace, passwordless sudo, and persisted host label. A separate VM booted the root snapshot with the backed-up workspace and verified the original credentials and root-owned project contents. This proof used synthetic data and did not exercise a running KasmVNC session or package installation over the network. Evidence: `app/SiloUI/src-tauri/target/verification/migration/live-migration.log` and `recovery.log`.

The exact inspected executable was `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Account Verification.app/Contents/MacOS/msb`, with the bundled ARM64 libkrunfw and `ubuntu-24.04-v3` guest image. Test runtime `/tmp/silo-migration-proof-idyf00si` is retained for migration/backup evidence; its migrated and recovery VMs are stopped, and the unbooted snapshot clone remains Created. No user's existing VM was accessed.


### Existing-VM migration follow-up

A live existing ARM64 VM exposed stale editor/agent sockets and the host's short
runtime-home alias. The copier now skips sockets and FIFOs, supports verified
resume with the original backup, and preserves the alias instead of resolving
it into a path exceeding the Unix socket limit. Private command diagnostics are
saved in the backup directory on failure. Original agent shell initialization
wins over desktop defaults, with the migrated `.local/bin` added to PATH.

Ten migration tests pass. A disposable interrupted-migration reproduction also
passed with partial symlinks and stale sockets. The existing VM subsequently
completed migration; Codex 0.155.1 launched as `silo`, its authentication bytes
matched the original, sudo/workspace access passed, and the actual desktop
reported running as `silo` on `:1`. It was stopped after verification with account
policy `1`. Verification used the account-aware runtime in
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Account Verification.app`;
the older installed application was left closed pending update.
