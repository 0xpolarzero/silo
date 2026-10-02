# Atomic persisted writes

## Image descriptor repair: fixed

`runtime/image_cache.rs` synchronized a staged descriptor before restoring its
permission bits, then returned after rename without synchronizing the directory.
The pinned [tempfile 3.27.0 contract](https://docs.rs/tempfile/3.27.0/tempfile/struct.NamedTempFile.html#method.persist)
does not synchronize either the file or directory. Linux's
[fsync contract](https://man7.org/linux/man-pages/man2/fsync.2.html) requires a
separate directory sync for the renamed entry.

The writer now sets final permissions before file sync and syncs the directory
after replacement. A real permission fixture allows create/rename but denies
opening the parent directory, verifies complete replacement bytes and retained
permissions, and rejects success. The regression failed before the fix; all 12
tests in the actual module passed afterward using Rust 1.94.0 and the shared
target's cached tempfile crate, with warnings denied. Root skips this permission
case because it bypasses that boundary. No app, VM, or storage crash was tested.

## Remote-management configuration: fixed

`remote.rs::save_config_in` synchronized JSON bytes but acknowledged the rename
without synchronizing its directory. It now completes that synchronization and
propagates failure. The same real permission fixture verifies a readable,
complete disabled configuration after publication while rejecting success when
the parent cannot be opened. The regression failed before the fix. All three
configuration I/O tests passed afterward in a harness containing the exact
production configuration types, reader, writer and tests, compiled with Rust
1.94.0 and warnings denied. This isolates persistence; it does not run the
Tauri or SSH adapters, and root skips the permission boundary.

## Editor SSH files: fixed

Both `editor.rs::write_private` and `replace_file` returned after atomic rename
without directory synchronization. They now sync the parent and propagate
failure. A real permission fixture checks both writers, including their distinct
permission rules, complete publication and absence of temporary files. The new
regression failed before correction; it and the existing byte-preservation and
symlink-refusal test passed with the exact production file functions isolated
from the editor adapters, using Rust 1.94.0 and warnings denied. Root skips the
permission fixture. No live SSH connection or editor was used.

## Secret metadata: fixed

`secrets.rs::save` synchronized its JSON file but omitted parent-directory sync
after publication. It now propagates that failure instead of acknowledging the
save. The regression verifies complete private JSON after replacement, rejects
the unsynchronized save and then successfully retries after restoring directory
access. It failed before the fix and passed afterward in a harness with the exact
production document types, thread-local path override, path resolver, writer and
test, compiled with Rust 1.94.0 and warnings denied. No credential store or guest
was accessed; root skips the permission boundary.
