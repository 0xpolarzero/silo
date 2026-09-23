# Disposable E2B lifecycle diagnostic patches

These patches reproduce two observed failure boundaries on a **separate owned
scratch host**. They are diagnostic source edits, not a production repair.
Apply each patch to its own copy of the public `e2b-dev/runtime` revision
`a065a4ddb3f2c6a4149634d9acb14b62f65839ac`. The captured baseline's
sorted per-file manifest SHA-256 is
`f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`.
The two patches must not be combined for a controlled run.

From the root of one clean extracted source copy:

```sh
patch -p1 --dry-run < /absolute/path/to/experiments/e2b-local/patches/d1-post-capture-exact-id.patch
patch -p1 < /absolute/path/to/experiments/e2b-local/patches/d1-post-capture-exact-id.patch
```

For a separate clean copy, substitute `d2-rootfs-sync-eio-exact-id.patch`.
Both dry runs passed against the captured baseline on 2026-09-23. The D1
diagnostic archive SHA-256 was
`a23c5b9019c1685a5f7b46462db6ac8b249025cd6605c0dd5ecad83f9be04e3e`;
the D2 archive SHA-256 was
`5285ba3a569fc0b2b5ffe59fa3a07c25fda1199ce6391855486c7a2e1aa773d6`.
The patch-file SHA-256 values are
`c53f8f44eed2e1555505529230f9bd8e61fe2fbc022d5297331e6bfdd536b5a1`
(D1) and `fb0740a0c7b70115eb96d362c9891e6a89f4b97fd9896d9e571c97bdcf178171`
(D2).

Build on Linux/ARM64 with Go 1.26.8, `CGO_ENABLED=1`, `GOWORK=off`, and
`go build -mod=readonly` from `packages/orchestrator/`. The tested D1 and D2
binary hashes, exact SDK run IDs, controls, result receipts and restoration
checks are in the [D1 note](../../../docs/research/e2b-d1-post-capture-repro-2026-09-23.md)
and [D2 note](../../../docs/research/e2b-d2-rootfs-sync-repro-2026-09-23.md).
Build hashes depend on flags and toolchain; compare these before using a test
binary. The captured source's dependencies differ at two versions from the
deployed release. Neither patch identifies an original incident cause.

The D1 hook requires `SILO_D1_FAULT_AFTER_SNAPSHOT=1` and
`SILO_D1_FAULT_TARGET_FILE` naming a file containing one exact sandbox ID. The
file must be absent during an unarmed control. Its return happens after
snapshot/cache registration, so it can leave an unfinished upload future.

The D2 hook requires `SILO_D2_ROOTFS_SYNC_EIO_DIR` naming an owned mode-0700
directory with one owned mode-0600 `<sandbox-id>.trigger` file containing
`<sandbox-id>` and a newline. It atomically renames the trigger to `.fired`
before returning synthetic EIO at the rootfs diff sync seam. It does not cause
a kernel writeback error. An unarmed pause/resume control must pass before
using the exact-ID trigger.

Keep raw guest memory and service logs in private ignored evidence. Verify
binary identity and guest inventory before a run, preserve the failed run's
report before cleanup, and restore the pinned orchestrator after the run. Do
not deploy either patch to the historical VM.
