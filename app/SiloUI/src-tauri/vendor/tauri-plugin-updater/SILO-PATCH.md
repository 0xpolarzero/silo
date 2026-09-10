# Silo patch to tauri-plugin-updater 2.11.0

Vendored unchanged from the crates.io 2.11.0 archive except `src/lib.rs`, the
macOS/AppImage installer delegates in `src/updater.rs`, and new
`src/atomic_install.rs`. Cargo cache markers, duplicate manifest, changelog and
upstream lockfile are omitted. Upstream licenses remain included.

Upstream installation renames the old application away before writing/moving its
replacement. A killed process can leave the installed path missing or partial.
The patch stages a complete replacement beside the installed application and
syncs it before one filesystem operation: Linux rename-over-file, macOS
`renamex_np(RENAME_SWAP)` for the bundle directory. No elevated shell command or
fallback to non-atomic replacement is allowed. An unwritable installation returns
an error with the existing app intact. Download and signature verification remain
Tauri's implementation; this changes only the replacement boundary.

Tests launch a child process and exit immediately before/after replacement,
asserting that the installed path always contains a whole old/new app. Malformed
payloads and symlink destinations preserve the old installation. Checkpoint
control exists only under cfg(test). Abrupt power loss still depends on host
filesystem/hardware durability; these tests prove process-interruption behavior.
A killed process can leave a hidden, owned staging directory beside the app.

Run the package tests through the Silo manifest so its pinned dependency graph
and patch configuration apply:

    cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml -p tauri-plugin-updater atomic_install -- --test-threads=1

Primary sources:
- https://docs.rs/crate/tauri-plugin-updater/2.11.0/source/src/updater.rs
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html
- https://man7.org/linux/man-pages/man2/rename.2.html

Keep this patch small and remove it when an upstream release provides equivalent
atomic replacement. This is a local patch, not a claim of upstream acceptance.
