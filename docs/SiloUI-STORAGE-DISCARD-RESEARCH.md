# Workspace discard must preserve disk capacity

Observed on 2026-09-20 with MicroSandbox 0.6.17, pinned source
`5eca4de8bf233e57f114140f8c076ea8c96f21ab` and `msb-imago` 0.1.5.

## Root cause

The guest's virtio discard reaches `discard_to_any` in
[msb_krun_devices 0.1.32 block worker](https://docs.rs/crate/msb_krun_devices/0.1.32/source/src/virtio/block/worker.rs).
The raw image forwards it to file storage.
[msb-imago 0.1.5 file storage](https://docs.rs/crate/msb-imago/0.1.5/source/src/file.rs)
implements a `try_discard_by_truncate` optimization: when the range reaches the
cached file size, it calls `file.set_len(offset)` and returns before the native
hole-punch operation. The cached capacity stays unchanged until the disk reopens.

This is not specific to macOS. The optimization runs before either macOS
`F_PUNCHHOLE` or Linux `FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE`.
Removing it preserves the logical disk length while releasing eligible physical
blocks. Restoring length after trimming is not the primary fix: an interruption
between truncation and restoration would still leave an undersized disk.

## Deterministic regression

A disposable 1 MiB file contains `0x5a` throughout. Through the actual imago
`StorageExt::discard` API, discard the last 512 KiB, sync, close, and reopen.
Assert that the reopened capacity and host file length remain 1 MiB, the first
512 KiB retain their bytes, and the last 512 KiB read as zero.

The unpatched crate fails with a reopened length of 524288 instead of 1048576.
The patched crate passes on APFS. The regression lives in the maintained runtime
patch as `tail_discard_preserves_length_across_reopen` and can run with:

```sh
cargo +1.94.0 test --locked -p msb-imago tail_discard_preserves_length_across_reopen
```

Run it from the prepared MicroSandbox source workspace. A standalone extracted
crate also supports this test. The standalone test was verified locally; the
initial workspace test required uncached registry dependencies unavailable in the
sandbox. The workspace's `cargo metadata --locked --offline --no-deps` passed.

## Build integration

`runtime-inputs.json` pins the combined MicroSandbox patch, which embeds the
imago correction and regression. Runtime preparation fetches the pinned Cargo
lockfile dependencies, verifies the imago crate archive against its lockfile
SHA-256, and extracts only that crate into the ignored build workspace. It never
modifies Cargo's shared registry source.

The builder applies a local `msb-imago` override and removes only that package's
registry source and checksum from the prepared lockfile. Every other dependency,
version, and checksum stays byte-for-byte identical. The build continues with
`--locked`; the changed combined patch digest invalidates cached runtime builds.
Two script tests verify source integrity and exact lockfile preservation.

## Existing worker processes

A new CLI executable does not prove that a VM already running in another process
uses the corrected storage implementation. Replacing an executable at the same
path leaves existing processes running their old mapped code.

The patched CLI advertises `--silo-storage-protocol` version `1`; runtime builds
validate the marker. Patched `inspect --format json` also exposes an opaque
`runtime_instance_id` consisting of the active database run ID and start time.
The identifier is null outside a running local VM or when the active row no
longer matches the handle's PID. Silo can stamp this identifier only after an
explicit start using the verified runtime and compare it before reclaiming.
Existing workers without a verified start require a restart.
