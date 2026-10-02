# Older VMs and the silo account

VMs created by Silo before the [silo working account](SiloUI-WORKING-ACCOUNT.md)
keep agent files under root, and some have a separate `silo-desktop` account.
Silo moves them to the `silo` account automatically the next time it starts
them. There is nothing to run by hand.

## At the first start

After every boot, Silo checks the VM's account record,
`/var/lib/silo/working-account.json`. When it is missing, Silo runs the guest
setup as root (`app/SiloUI/src-tauri/guest/working-account.sh` and
`working-account.py`), and the operation queue shows "Setting up the silo
account in NAME". The setup:

1. installs `python3`, `sudo` and `openssh-sftp-server` with apt if the image
   lacks them, which needs guest network access on older images;
2. checks its account tools, and refuses a UID/GID 1001 or `/home/silo` that
   belongs to something else, before changing anything;
3. renames `silo-desktop` to `silo`, or creates `silo`;
4. copies `/root` and `/home/silo-desktop` into `/home/silo`, keeping
   credentials byte for byte and relocating absolute home symlinks and launch
   scripts. Root dotfiles still identical to the distribution's defaults are
   skipped, and so are sockets and named pipes;
5. gives `silo` ownership of its home and of `/workspace`, without crossing
   mounts or following symlinks, installs passwordless sudo, and verifies the
   account;
6. writes the record last.

Generated sudoers, desktop service, configuration claim and account record files
are published individually through temporary files in their destination
directories. Setup applies each file's final permissions, flushes and fsyncs
its bytes, replaces the destination, then fsyncs the directory. This uses
Python's [standard file operations](https://docs.python.org/3/library/os.html#os.fsync)
and the existing guest patcher's publication sequence; Linux
[fsync](https://man7.org/linux/man-pages/man2/fsync.2.html) requires the separate
directory sync to persist the renamed entry. It does not make account migration
one transaction. A subprocess fixture with a real file-size limit proves that
an interrupted service write preserves the installed service and a fresh
process can retry setup. Separate tests inject file and directory sync errors.

A new VM takes the same path with an empty `/root`. Each step checks what an
earlier run already did. Start retries interrupted setup; home conflicts require
resolution first. If setup fails, Silo stops the VM and shows the reason. A record
this Silo does not recognise, for example from a newer Silo, is never
overwritten: the start fails and asks for an update.

The first start of a large VM can take minutes, mostly for `/workspace`
ownership. Copying home folders fills the VM's memory with file cache; if the
host runs out of memory and the VM is killed, Silo says so.

The record lives on the VM's disk, so a checkpoint, fork or export taken before
the move is set up the same way at its first start.

## Nothing is deleted

The original `/root` and `/home/silo-desktop` stay in place. Files that did not
move as expected can be copied from them with `sudo`. Agent session histories
are copied unchanged, so a history that names an old absolute working directory
is not rewritten. The `silo-desktop` service name and `/var/lib/silo-desktop`
keep their names; they are not separate login accounts. Custom account
arrangements and host-shared workspace mounts are not supported.

Older Silo versions recorded the account in a runtime label,
`silo.working-account=1`. Silo no longer reads or writes it; existing labels are
ignored.

## Home conflicts and retries

Each legacy home copy checks every destination entry before copying that home's
files. Existing directories merge; identical files and relocated links are left
in place. A different file, link, or entry type stops setup with a `Home migration
conflict` error naming the path. Destination links, including dangling links and
links in parent directories, are never traversed. Both legacy homes and the
conflicting destination entry stay in place. Preserve or move the named entry
inside the guest before retrying Start. Copy failures can leave completed files;
retry accepts their original or relocated contents without overwriting them.
New files are staged beside their destination and published only after copying
and launcher relocation finish. A partial file left by an earlier Silo reports
a conflict and is preserved for resolution.

Root's shell setup remains authoritative: regular shell files already in the new
home are skipped during merging, then root's customized shell files replace
them atomically, leaving any other hardlinks to the previous file unchanged.
Shell links and directories cause a conflict instead of being removed.
Unchanged distribution defaults remain skipped.

Shell and launcher relocation includes whole home values such as `HOME="/root"`
and keeps external paths such as `/opt/root/tools` unchanged. The shared
[Python byte-pattern substitution](https://docs.python.org/3.12/library/re.html)
preserves existing encodings and line endings. Only legacy home tokens and
their descendants are relocated; matching text inside another path is retained.

Python 3.12's [copytree contract](https://docs.python.org/3.12/library/shutil.html#shutil.copytree)
preserves source links with `symlinks=True`, but `dirs_exist_ok=True` permits
destination overwrites. It provides no destination-link preservation policy.
The helper therefore preflights entries with
[lstat](https://docs.python.org/3.12/library/pathlib.html#pathlib.Path.lstat)
and copies missing files with the standard library's `copy2`, preserving the
existing launcher relocation rules without scanning unrelated destination files.

## Verification

Rust tests in `working_account.rs` cover the check, the setup command, the
setup's own failure reasons, other failures with their Details, a VM that
crashes during setup, and records written by every earlier Silo. A `runtime.rs`
test drives a fake runtime through a start, a failed setup that stops the VM, a
temporary boot and a restore. The guest copy rules have Python tests:

```sh
python3 -m unittest discover -s app/SiloUI/scripts -p test_working_account.py
```

The destination-conflict tests use temporary synthetic homes only. They cover
two-home merges, file and directory links, nested and dangling links, entry-type
conflicts, unchanged credential and binary bytes, and interrupted-copy retries.
These tests passed on Python 3.12.9 on macOS; the revised conflict policy has not
been qualified in a live Ubuntu guest.

`app/SiloUI/scripts/test-working-account-live.py` is the opt-in live test in a
disposable VM. It covers missing tools, a UID collision, copied root files, an
interrupted setup, a malformed record, and the account's exec, SSH, SFTP and Git
behaviour.

### History

Earlier versions refused to start older VMs; a separate script, later an in-app
action, moved them after taking a disk backup. The earlier guest copy policy
was verified live on 2026-09-25 on disposable Ubuntu 24.04 x86-64 and
ARM64 VMs and on an existing ARM64 VM, where Codex launched as `silo` with
unchanged authentication. On 2026-09-30 an existing x86-64 VM on Linux moved
with all 219,147 `/workspace` entries owned by `silo` and its 30,203 root home
files present in `/home/silo`. The backup was dropped: the move copies home
folders and leaves the originals, and otherwise changes only ownership and
account settings.
