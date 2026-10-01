# Pinned ChatGPT app on each computer

Implements section 4 of the [computer use plan](SiloUI-COMPUTER-USE-PLAN.md).
Code: `app/SiloUI/src-tauri/src/chatgpt_app.rs`, lock:
`app/SiloUI/src-tauri/guest/chatgpt-app-lock.json`. It is not yet wired into VM
creation or the UI; remote computers run it on the owning computer.

## Behavior

The LCU computer-use runtime needs the official ChatGPT Linux app. Silo never
publishes OpenAI files. After the user accepts a one-time notice, the computer
that hosts VMs downloads the pinned `.deb` from OpenAI and keeps one read-only
copy that all its VMs mount. Guest architecture equals host architecture, so
the Debian architecture is `arm64` on Apple Silicon and Arm Linux, `amd64` on
x86-64.

`ensure(root, lock, arch, downloader, report)`:

1. Returns the published folder at once if it is *verified* (below; no lock,
   no network).
2. Refuses with a `notConsented` error unless the notice was accepted.
3. Takes an exclusive `flock` on `<root>/.lock`; concurrent callers (threads or
   processes) wait, then verify the folder again.
4. Removes whatever is under the published name that failed verification (a
   folder without a valid record, a damaged or tampered tree, a symlink): the
   record first, then the folder, which is moved aside to `.rejected-*` and
   deleted. Nothing is ever trusted because of its name.
5. Downloads the exact pool URL over HTTPS only (redirects must stay HTTPS)
   into `downloads/chatgpt_<version>_<arch>.deb.part`, resuming with `Range`
   after a failure, up to 5 attempts with 2/4/8/16 s backoff, 20 s connect
   timeout and a 30 minute bound per attempt (the blocking `reqwest` client has
   no stall timeout; a retry resumes where it stopped).
6. Verifies size, then SHA-256, against the lock. A failing file is deleted. A
   hash mismatch is not retryable.
7. Streams the decompressed `data.tar` from an established tool, validates
   every entry and writes the `usr/lib/chatgpt` entries into `.staging-*` on the
   same volume. No maintainer script ever runs. The first rejected entry aborts
   at once and kills the unpacking tools without draining the package.
8. Publishes in a crash-safe order: every file is synced as written; directories
   are synced bottom-up; the tree digests are computed from what is on disk;
   the staging directory is renamed to `<version>-<debarch>` and the parent is
   synced; the **publication record** is then written (exclusive temporary,
   sync, rename, parent sync). The record is the last durable step, so a crash
   at any earlier point leaves a folder that is never reused. The `.deb` is
   deleted after the record is durable. Every sync error aborts publication
   (and removes a tree whose record could not be written).
9. Returns the canonicalized absolute path (MicroSandbox refuses mount roots
   through symlinks, for example macOS `/tmp`).

A published folder is never modified. If the rename fails, a folder that
appeared meanwhile is accepted only if it passes verification.
Stale `.staging-*`, `.rejected-*` and temporary files are removed on the next
call.

`collect_garbage(root, lock, arch, in_use)` removes `<version>-<arch>` folders
(and their records) that are neither pinned nor in `in_use` (folder names),
stale staging directories and downloads of other versions.

## Filesystem safety

Another process, a previous run or a hostile VM share could leave links or
folders in the storage directory, so nothing is trusted by path:

- The storage root must be a real directory (never a symlink) owned by the
  current user; it is opened with `O_NOFOLLOW|O_DIRECTORY`, checked with
  `fstat` and, when Silo creates it, tightened to 0700. A root writable by
  others, owned by someone else or reached through a symlink refuses every
  operation (consent, lock, status, ensure, garbage collection). Ancestors of
  the root (for example `~/Library`) are the user's own and are not checked.
- Subdirectories (`downloads`, `.staging-*`) are opened relative to that handle
  with `O_NOFOLLOW` and checked for ownership. All writes use `openat`-style
  calls (`mkdirat`, `openat` with `O_CREAT|O_EXCL|O_NOFOLLOW`, `symlinkat`,
  `renameat`, `unlinkat`) relative to those handles, one component at a time,
  so no component can be swapped for a link between a check and its use.
  Extraction opens each parent directory component by component the same way.
- Files Silo creates (consent, record, download `.part`, tree files) are made
  exclusively. A planted `.part` (a symlink, a hard link, someone else's file)
  is deleted, never opened through. A resumed download re-checks what it opened
  (regular file, one link, owned by the user).
- Removal never follows links (`unlinkat`; directories are renamed aside and
  deleted with `remove_dir_all`).

## Publication record and verification

`<root>/<version>-<debarch>.published.json` sits next to the tree (never inside
it) and holds: schema version, lock version, architecture, the `.deb` SHA-256
from the lock, `treeSha256`, `statSha256`, entry count and byte count.

`treeSha256` is SHA-256 over the sorted list of (path, type, mode, size,
symlink target) plus each regular file's SHA-256. `statSha256` covers the same
shape and metadata plus file mtimes, without reading file contents. Trees with
a set-id or group/other-writable entry, a hard link, a device or anything that
is not a file, directory or symlink never have a digest.

A folder is "ready" (`verify_published`) only when:

1. Every call: the record exists, is a plain file owned by the user and parses;
   it matches the current lock (version, architecture, `.deb` hash); the root
   and the version folder are real directories owned by the user, not group or
   other writable; `ChatGPT`, `resources/cua_node/bin/node` and
   `resources/cua_node/bin/node_repl` are regular files with an execute bit; and
   the tree's stat digest equals the record (a few thousand `lstat`s, tens of
   milliseconds).
2. Once per process for each tree (and again whenever the stat digest or the
   identity of the record or tree changes): the full content digest equals
   `treeSha256`. Publication seeds the per-process cache, because it just
   computed the digest. The cache is in memory, so every app start verifies
   every byte once.

Trade-off: a same-size, same-mtime in-place edit made after the first check in
a running app is not seen until the next start. Anything that changes size,
mtime, mode, names, links or shape is caught on the next call. An
attacker who can edit the tree can also edit the record and the cache is not
a defense against that; the record binds the tree to the lock and detects
accidents, partial writes, stale or hand-made folders and tampering by
processes that do not also rewrite the record. Mounting is read-only, so a VM
cannot change it. Verification runs on whichever thread calls `ensure` or
`current_status`; the first full check of a process takes a few seconds in a
release build (see Verification), so UI code should not call it on the render
path.

## Paths (per channel)

Under `app_data_dir()/chatgpt`, which Tauri derives from the bundle identifier,
so production (`org.silo.preview`) and Dev (`org.silo.dev`) never share it, as
[build channels](SiloUI-BUILD-CHANNELS.md) require. On macOS that is
`~/Library/Application Support/<identifier>/chatgpt/`.

```text
.lock  consent.json  downloads/  .staging-*/  <version>-<debarch>/
<version>-<debarch>.published.json
```

The `<version>-<debarch>` folder holds what dpkg would place in
`/usr/lib/chatgpt`: `ChatGPT`, `resources/…`. It is the directory to mount
read-only; mount only this folder (large mounts slow the first `statfs`).

## Consent

`consent.json` records the accepted notice version (currently 1). Raising
`NOTICE_VERSION` asks again. It is channel scoped by the directory above.
`accept_notice` is the only writer.

## Status

`Status` serializes with a `state` tag: `notConsented`, `idle`,
`downloading {receivedBytes,totalBytes}`, `verifying`, `extracting`,
`ready {path,version}`, `failed {reason,retryable}`. The reporter is called
from the worker thread (downloads throttled to 4 per second).

Tauri commands, written but not registered (registration needs `build.rs`
permissions, `capabilities/preview.json` and `main.rs`, which integration
owns): `chatgpt_app_status`, `chatgpt_app_accept_notice`,
`chatgpt_app_prepare` (async, runs `ensure`, emits the `chatgpt-app-status`
event).

## Extraction and validation

Tool choice, per [reuse established tools](../AGENTS.md): macOS runs
`/usr/bin/tar -xOf x.deb data.tar.xz` into `/usr/bin/tar -cf - @-` (bsdtar
reads the `ar` container and rewrites the member as plain tar); Linux runs
`dpkg-deb --fsys-tarfile` (dpkg is essential on Ubuntu). Rust has no xz
decoder in the dependency graph, and adding `xz2`/`liblzma-sys` would put a C
library in the build for something the OS already provides. The existing `tar`
crate parses the stream; Silo writes files itself so no entry is trusted.

Per entry inside `usr/lib/chatgpt`:

- Only regular files, directories and symlinks. Hard links, devices, FIFOs
  and anything else abort. Entries outside the tree are skipped, never written.
- Names must be UTF-8, relative, free of `..`; a leading `./` is accepted.
- No setuid or setgid bit. Files become `0755` if any execute bit is set, else
  `0644`; directories `0755`.
- Symlink targets are relative; leading `..` may not exceed the link's depth
  and no `..` may follow a normal component (so a chain through another
  symlink cannot leave the tree). No entry may be written through a symlink.
- Case-insensitive collisions and duplicates abort; files are also created
  with `create_new`, so a name the filesystem folds (APFS) fails.
- Limits (checked with `u64` checked arithmetic): 200,000 entries; 8 GiB
  written in total, accounted on each entry's *effective* size (`Entry::size`,
  which honors a PAX `size` record that overrides the header) before any byte
  is written, and again on the bytes copied; entries outside the tree count
  towards the entry limit; paths and link targets up to 4096 bytes (this
  includes GNU long names) and 255 bytes per component; PAX extended header
  records up to 64 KiB per entry; directories and links must have size 0; the
  tar stream itself is capped at twice the byte limit, which bounds metadata
  the `tar` crate buffers internally.
- ChatGPT, `resources/cua_node/bin/node` and `resources/cua_node/bin/node_repl`
  must be regular, executable files (symlinks inside the tree are followed
  to check this).

The first violation aborts extraction immediately and discards the staging
folder; nothing is published.

## Sources

Version 26.928.31416 comes from OpenAI's apt repository
(`https://persistent.oaistatic.com/codex-app-prod/linux/deb`, suite `stable`,
key `3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4`), whose newest version is now
26.928.40906; older versions remain in the pool. Checks on 2026-10-01: the
pool URL for both architectures answers with the locked sizes (453,121,290 and
474,894,546 bytes); the arm64 SHA-256 was recomputed from a fresh download and
equals the lock. The amd64 hash comes from the signed index as recorded for the
plan and has not been recomputed locally; the OpenAI InRelease signature could
not be checked here (no gpg), only its hash chain to `Packages`.

The runtime pair is `0.0.27/20260927214556-b77d38801cca`
(`resources/cua_node/manifest.json`). `lcuVersion` is `null` until integration
fills in the tested LCU release. The owner updates the pair by hand.

## Verification

Unit tests (`cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked
chatgpt_app`) build synthetic `.deb` files (ar container plus gzip data member)
in the test and cover hash and size mismatch, consent, absolute, `..`,
escaping and chained symlinks, write-through-symlink, setuid/setgid, devices,
hard links, case collisions, duplicates, missing or non-executable required
files, atomic publish, reuse after interruption, concurrency, garbage
collection and status JSON. `tests/hardening.rs` adds planted symlinks (download
part file, staging folder, version folder, storage root, downloads folder,
consent file), a preseeded fake version folder, a forged tree under a genuine
record, tampering after publication (same-size edit seen by the full digest,
size, added, removed, relinked and loosened-mode changes seen by the cheap
check), an interrupted publish (no record, torn record, partial tree), record
binding to the lock, PAX size larger than the header size, checked size sums,
long-name, PAX and entry-count limits, abort at the first rejected entry, and
exclusive consent files. They use temporary directories and no process-wide
Silo state (the in-memory verification cache is keyed by path).

Opt-in live test, downloads 453 MB and unpacks about 1.5 GB into a temporary
directory:

```sh
SILO_LIVE_TEST_CONFIRM=disposable-test-fixtures \
  cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked \
  chatgpt_app::tests::live -- --ignored --nocapture
```

Run on 2026-10-01 (macOS arm64, Rust 1.94.0): download, verification,
extraction and publication took about 52 s; the layout check and idempotent
second call passed.

Run on 2026-10-02 after the hardening (macOS arm64, Rust 1.94.0, release test
profile, real package: 4,479 entries, 1,560,896,612 bytes): download,
verification, extraction, sync, digest and publication took about 58 s; the
cheap reuse check (record, executables, stat digest) took 28 ms; the first
full content digest of a process took 6.2 s. In the unoptimized debug test
profile SHA-256 is about 20 times slower (the full digest took 121 s), which
is a test-profile artifact only.
