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
