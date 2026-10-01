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

1. Returns the published folder at once if present (no lock, no network).
2. Refuses with a `notConsented` error unless the notice was accepted.
3. Takes an exclusive `flock` on `<root>/.lock`; concurrent callers (threads or
   processes) wait, then find the published folder.
4. Downloads the exact pool URL over HTTPS only (redirects must stay HTTPS)
   into `downloads/chatgpt_<version>_<arch>.deb.part`, resuming with `Range`
   after a failure, up to 5 attempts with 2/4/8/16 s backoff, 20 s connect
   timeout and a 30 minute bound per attempt (the blocking `reqwest` client has
   no stall timeout; a retry resumes where it stopped).
5. Verifies size, then SHA-256, against the lock. A failing file is deleted. A
   hash mismatch is not retryable.
6. Streams the decompressed `data.tar` from an established tool, validates
   every entry and writes the `usr/lib/chatgpt` entries into `.staging-*` on the
   same volume. No maintainer script ever runs.
7. `fsync`s files and the staging directory, renames it to
   `<version>-<debarch>` (atomic), syncs the parent, deletes the `.deb`.
8. Returns the canonicalized absolute path (MicroSandbox refuses mount roots
   through symlinks, for example macOS `/tmp`).

A published folder is never modified. A folder lacking the `ChatGPT`
executable (a crash cannot produce one; manual damage can) is replaced.
Stale `.staging-*` folders are removed on the next call.

`collect_garbage(root, lock, arch, in_use)` removes `<version>-<arch>` folders
that are neither pinned nor in `in_use` (folder names), stale staging
directories and downloads of other versions.

## Paths (per channel)

Under `app_data_dir()/chatgpt`, which Tauri derives from the bundle identifier,
so production (`org.silo.preview`) and Dev (`org.silo.dev`) never share it, as
[build channels](SiloUI-BUILD-CHANNELS.md) require. On macOS that is
`~/Library/Application Support/<identifier>/chatgpt/`.

```text
.lock  consent.json  downloads/  .staging-*/  <version>-<debarch>/
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
- Limits: 200,000 entries, 8 GiB unpacked.

Any violation discards the staging folder; nothing is published.

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
hard links, case collisions, duplicates, missing executable, atomic publish,
reuse after interruption, concurrency, garbage collection and status JSON.
They use temporary directories and no process-wide Silo state.

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
