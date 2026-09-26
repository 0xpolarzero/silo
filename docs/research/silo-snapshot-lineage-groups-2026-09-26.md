# Silo snapshot lineage groups

## Finding

MicroSandbox 0.7.2 resolves a snapshot parent from a same-group sibling before
it searches the global snapshot identity index. The global lookup rejects an
ID when more than one local copy exists. Silo previously gave every backup
capture a fresh `silo-export-*` group while saving the full parent chain. After
an archive was loaded once into the same `MSB_HOME`, the original and imported
groups contained duplicate copies of the parent ID; a fresh-group capture of
the original then failed while saving its parents. The evidence supports a
Silo lineage-group integration error, not an upstream defect.

## Reproduction and controls

The reproduction used the pinned official MicroSandbox 0.7.2 Linux x86-64
binary (`bdaa6c6f…f8b16`) and one isolated task-owned `MSB_HOME`; no Silo
application, app patches, retries, or failed imports were involved in this
minimal case. A fresh one-snapshot source was exported with
`snapshot save <source-group>:<seed> <archive> --with-parents --with-image`,
then loaded exactly once into that same home with
`snapshot load <archive> --group import-minimal-once`. The snapshot index showed
two copies of seed ID `snap_42b68454c752d97ef5358e7a6aa26528`: the original source
group and `import-minimal-once`. A child capture in fresh group
`fresh-export-minimal` succeeded, but saving it with parents failed with:

```text
snapshot identity snap_42b68454c752d97ef5358e7a6aa26528 has 2 local copies; use group:member or an explicit artifact path
```

Controls in the same home succeeded when original, imported source, and its
fork each captured and saved into their existing lineage group. A separate
fresh home also passed two exports after a single archive load, which avoided
duplicate ancestor IDs and therefore did not exercise the failing condition.

Pinned source corroborates the resolver behavior: `sdk/rust/lib/backend/local/
snapshot/archive.rs::resolve_parent_artifact` follows a local sibling first
and then rejects ambiguity in the global index. `snapshot/lineage.rs` stores
the parent snapshot ID in the source cursor. The SDK documents group/member
selectors and requires ambiguous global identities to be disambiguated. These
findings explain why stable groups resolve the reproduction; they do not
establish that MicroSandbox violates its supported contract.

## Silo change and verification

Silo now persists one `snapshotGroup` in each checkpoint record. A normal
workspace records its name when it first captures a checkpoint or backup; an
archive import records the exact loaded `silo-import-*` group; a fork inherits
the selected checkpoint's group. Checkpoint creation, recovery capture,
verification, restore, fork, and backup capture use that saved group. The
pending import/fork selector remains authoritative until Start succeeds, and
the group then remains in the record after pending state clears. Original
version-1 checkpoint records migrate once to the historical default sandbox
group. A saved record with missing group and no recoverable checkpoint or
pending selector fails closed instead of guessing an imported lineage.

Focused synthetic-configuration Rust tests passed locally: checkpoint module
12/12, backup module 25/25, and backup-controller module 12 passed / 1 ignored
(the ignored test requires the packaged runtime and KVM). The production
same-home Silo export matrix is pending a stopped-fixture handoff from the
Linux UI qualification run. Its acceptance assertion is two successful
production exports each for the original workspace, a once-imported workspace,
and a fork of that imported workspace, with each workspace retaining its
selected group across Start and relaunch.

## Current x86 qualification setup

The x86 runner is Ubuntu 24.04.5 (`6.8.0-139-generic`) under Ubuntu 26.04
nested KVM. An unprivileged probe opened `/dev/kvm`, received API version 12,
and created a VM through `KVM_CREATE_VM`. The exact AppImage under test is
`Silo_0.9.0_amd64.AppImage`, SHA-256
`54b5a5c3d10e5ff2bc0047383d1a534591faedad9c676a44da03fbc43825d6fc`; its
ordinary AppRun smoke passed native WebKit/IPC routes, backup/settings, and
full relaunch. The UI agent still owns the guest's chooser/editor fixture until
it hands off stopped app/driver/VM state.

The isolated historical CLI build used official MicroSandbox 0.6.17 source
commit `5eca4de8bf233e57f114140f8c076ea8c96f21ab` (source archive SHA-256
`2b31ce2d344c585c8591567ec21dbf0c9a36bcf832f050215776b3ea79695e06`) and the
exact stopped-create patch SHA-256
`4c0eb66547fa8c6481ce36bf2d1f27dfce9da35c2fbd6e3ea85947567328d907`. The
Rust 1.94.0 release build succeeded; the binary reports `msb 0.6.17`, its
account-protocol probe returns `1`, and its SHA-256 is
`e4354b44a66e746d3d95b5f04ba429c46e46d97b31f7b19fc478c8d11410e32b`. It is
staged outside the UI guest; no predecessor VM has been created there yet.
The production matrix script is
`app/SiloUI/scripts/test-linux-snapshot-groups.py` (SHA-256
`191c88c48ab60d548925ba572a5a74c9efe62eafee1d2b6028adcaed86877c78`); it
requires the actual package ID and isolated XDG/archive/evidence paths as
explicit inputs.
