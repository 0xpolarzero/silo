# Migrate an older VM to the silo account

Silo requires the `silo` working account (UID/GID 1001) inside each VM. New VMs
already have it. Older VMs keep agent files under root, and some have a separate
`silo-desktop` account. Silo refuses to start or open them until they are
migrated or recreated.

## In the app

A VM on the old layout shows **Old account layout** in the sandbox list, and its
Start, Terminal and Editor controls explain why they are unavailable. Choose
**Migrate to the silo account…** from its ⋯ menu, or **Migrate…** on its page.
Before anything changes, Silo runs a dry run and shows:

- the steps below, including whether the VM is stopped first;
- the backup's maximum size and its folder;
- the free space on that volume, and whether the backup fits;
- a warning that files inside the sandbox are rewritten;
- on Linux, a warning when the computer has less memory available
  (`MemAvailable`) than the VM's memory.

Migrate is unavailable until the backup fits; **Check again** repeats the dry
run after you free space. The memory warning does not block the migration.
Copying the home folders fills the VM's memory with file cache, so a VM can use
all of its memory during the migration even if it normally uses little. When
the host runs out, Linux kills the VM process. Stop other VMs first. On
2026-10-01 a 12 GiB VM was killed this way on a 15 GiB host while another 12 GiB
VM was running. macOS compresses and swaps memory instead, so Silo shows no
memory figure there.

The migration waits its turn in the VM's lane of the operation queue, like
Start or a checkpoint, and the queue shows its current step. It can be
cancelled while Silo checks the sandbox and backs up its disks. A cancel then
discards the partial backup and leaves the VM unchanged and stopped. Once the
VM boots for migration, the attempt runs to the end, because an interruption
would need Retry to finish.

On success the VM is stopped and ready to start, and a notice names the backup
folder. On failure, the sandbox page shows the exact error with **Details**, the
backup folder, and **Retry**. Retry continues with the same backup; if the
backup itself failed, Retry backs up the disks again. If the VM crashed while
a command ran inside it, the error says the sandbox stopped unexpectedly and
suggests freeing memory, rather than reporting the runtime's lost session.

A sandbox on another computer is migrated by that computer, in its own queue,
with its backup on that computer. Both computers must run a Silo version with
this feature.

## What it does

The host orchestration lives in
`app/SiloUI/src-tauri/src/runtime/account_migration.rs`. The account rewrite is
the guest payload `app/SiloUI/src-tauri/guest/migrate-working-account.py`, sent
unchanged. In order:

1. Check that the bundled runtime supports the account protocol and that the VM
   is a Silo-managed VM with no account label and the standard owned
   `/workspace` disk. Running, stopped, created and crashed VMs are accepted.
2. Stop the VM if it is running.
3. Back up both disks with one MicroSandbox disk snapshot
   (`snapshot create --from-sandbox VM --dest-dir … --integrity`). With the
   owned workspace volume, the snapshot holds the root disk and `/workspace`.
   The backup is kept out of the sandbox's snapshot history (see
   [Snapshot history](#snapshot-history)).
4. Start the VM through Silo's normal runtime path, so its secrets and GitHub
   access profile are supplied as for any start. Install `python3`, `sudo` and
   `openssh-sftp-server` with apt if any is missing; older images need guest
   network access for this.
5. Run the guest payload as root. It copies `/root` and `/home/silo-desktop`
   into `/home/silo`, keeps credentials byte for byte, relocates absolute home
   symlinks and launch scripts, gives `silo` ownership of the home and of
   `/workspace` (without crossing mounts or following symlinks), installs
   passwordless sudo, and verifies the account. The original home folders stay
   in place. The `silo-desktop` service name and `/var/lib/silo-desktop` keep
   their names; they are not separate login accounts.
6. Stop the VM, and only then save `silo.working-account=1` with `msb modify`
   and check that the runtime kept it.

A saved Start from before, which the old layout refused, is retired when the
migration begins, so it does not resume at the next launch.

Agent session histories and credentials are copied unchanged; a session history
that names an old absolute working directory is not rewritten. Custom account
arrangements and host-shared workspace mounts are not migrated.

## Backup

Backups are kept in `account-migration-backups/<sandbox>-<first ID block>/`
beside the runtime's `machines.json`, for example
`~/Library/Application Support/org.silo.preview/<runtime>/account-migration-backups/dev-3f2a1b4c/`
on macOS or `~/.local/share/org.silo.preview/<runtime>/…` on Linux. The folder
is private (mode 0700) and contains:

- `migration.json`: progress (`backing-up`, `backed-up`, `completed`), the
  snapshot path relative to the folder, and the last failure;
- `inspect.json`: the VM's runtime inspection before migration;
- `snapshot/<sandbox>/snap_<id>/`: the MicroSandbox snapshot of both disks.

The dry run sizes the backup as the host space allocated to the VM's root and
workspace disks, and requires that plus 2 GiB, because the guest copies the home
folders on the root disk. On APFS the snapshot is a copy-on-write clone and
usually takes far less space; on ext4 it is a sparse copy of the allocated data.

Silo keeps the backup after success. It contains project files and
credentials; remove it once you have checked your agents and files. Remove it
with the runtime rather than only deleting the folder, so the runtime's snapshot
index forgets it too (use the exports and paths from the recovery section below):

```sh
"$MSB_PATH" snapshot remove "$SNAPSHOT"
rm -r "$BACKUP"
```

A stale index entry left by deleting only the folder is harmless to the migrated
sandbox, but if the sandbox had checkpoints before migration, Silo cannot delete
the newest of them while that entry names it as a parent.

Silo never reuses a finished backup or a folder it did not create: migrating the
same sandbox again later writes to the next free `-2`, `-3`… folder. Error
messages do not name the folder, because Silo removes paths from them; the
confirmation, the failure on the sandbox page and the result notice show it.

### Snapshot history

MicroSandbox makes each capture of a sandbox the parent of its next capture, and
Silo's exports include that ancestry (`snapshot save --with-parents`). Left
alone, the backup would become the parent of every later checkpoint and export:
exports would carry a second copy of the disks, and removing the backup would
make them fail with "snapshot not found". This was verified on 2026-09-30 with
the bundled 0.7.4 CLI. The previous command-line script had the same effect.

MicroSandbox has no capture option that leaves ancestry unchanged, so Silo reads
the ancestry cursor it keeps beside the sandbox (`snapshot-lineage.json`) before
the backup and puts it back afterwards, also after a failed or cancelled capture.
Later captures then name the previous parent, and the backup can be removed
without affecting them. Silo holds the VM's lane in the operation queue meanwhile,
so no other capture of that VM runs. The backup itself still records the earlier
checkpoint as its parent, which is why the index entry above matters. This is a
workaround for an upstream gap; a MicroSandbox capture option that does not
advance ancestry would replace it.

Retry of an interrupted migration verifies the snapshot with
`snapshot verify` before continuing, and runs the payload with `--resume`,
which accepts a half-renamed account and repeated home copies. Stale Unix
sockets and named pipes are not copied; their programs recreate them.

## Recover files from a backup

A failed migration leaves the VM without the account label. Do not set the
label by hand. To read the old files, restore the snapshot as a separate VM with
the bundled runtime of the same Silo installation, so its image cache holds the
snapshot's base image. This is a local recovery backup, not a portable export.

```sh
export MSB_HOME="$HOME/.silo/RUNTIME_ALIAS"
export MSB_BACKEND=local
export MSB_PATH=/Applications/Silo.app/Contents/MacOS/msb
export MSB_LIBKRUNFW_PATH=/Applications/Silo.app/Contents/Frameworks/libkrunfw.5.dylib
BACKUP=/absolute/path/to/account-migration-backups/dev-3f2a1b4c
SNAPSHOT="$BACKUP/$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshot"])' "$BACKUP/migration.json")"
"$MSB_PATH" snapshot verify "$SNAPSHOT"
"$MSB_PATH" restore "$SNAPSHOT" --name account-recovery
"$MSB_PATH" modify account-recovery --label-rm silo.managed --label-rm silo.machine-id
"$MSB_PATH" exec account-recovery --user root -- /bin/bash
"$MSB_PATH" stop account-recovery
```

Choose a recovery name that does not exist. Removing the labels keeps Silo from
seeing a second VM with the same identity. Copy what you need into a newly
created Silo VM rather than editing Silo's machine registry.

## Verification

Host orchestration is covered by Rust tests in `account_migration.rs`: the dry
run, a successful migration (backup before boot, label only after a clean
stop), a guest failure that keeps the backup and never publishes the label,
Retry with `snapshot verify` and `--resume`, a failed backup that is removed and
redone, a cancelled backup, insufficient space, a VM that crashes during the guest
step, the VM memory and host `MemAvailable` in the dry run, layout and identity
checks, and the operation-queue labels and cancellability. The guest payload keeps its
Python tests:

```sh
python3 -m unittest discover -s app/SiloUI/scripts -p test_migrate_working_account.py
```

They cover credential preservation, home-path relocation, pipes and sockets, and
the reserved identity on resume. They do not prove Linux account changes or a
live desktop session.

### History

The in-app action replaced `scripts/migrate-working-account.py`, which accepted
only the external `DiskImage` workspace mount. After the runtime migration
converted every VM to an owned workspace volume, that script could no longer
migrate any VM. Its guest payload was verified live on 2026-09-25 on disposable
Ubuntu 24.04 x86-64 and ARM64 VMs with the 0.7.2 runtime (UID/GID 1001,
credentials, relocated symlinks, SFTP, sudo, workspace ownership, persisted
label), and on an existing ARM64 VM after an interrupted run, where Codex
launched as `silo` with unchanged authentication and the desktop ran as `silo`.
