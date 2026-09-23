# D3 failed restore: exact artifact inventory

Date: 2026-09-23. Scope: read-only inspection of the already-running owned
historical Lima VM `silo-e2b-poc` and preserved local logs. No sandbox was
connected, resumed, deleted, or changed. This identifies the failed restore's
catalog and file set; it does not determine the panic's cause.

## Exact failed restore

The historical orchestrator container log reports a Firecracker
`/snapshot/load` request at 2026-09-22 18:59:02+02:00 for sandbox
`ihgs21sl03xx1a6jao8ah`, build
`4d52ff40-ea41-4b1d-887c-0c000e4a5a8f`, snapshot template
`2zow77tphtoidyg1lt2g`. The log names cache path
`/orchestrator/template/4d52ff40-ea41-4b1d-887c-0c000e4a5a8f/cache/6cd04d16-5b7e-4a9d-b391-a09918b8cebf/snapfile`.
At 18:59:02.397 the same sandbox log reports `The number of available virtio
descriptors 41919 is greater than queue size: 256!`; the ensuing create error
was an EOF while setting the network TX rate limit after Firecracker exited.
The process was orchestrator PID 5848, whose current executable hash is recorded
in the provenance audit. This association is stronger than the manually
assembled `durability.json` verdict.

The source instance was marked stopping at 18:53:27.478, and the background
task logged `snapshot finished uploading successfully` at 18:53:34.927 for
that sandbox. The restore attempt was roughly five minutes later. This
disconfirms the simple claim that the attempt necessarily raced an upload still
in flight. It does not establish that every referenced ancestor/body/chunk was
durable or correctly reconstructed.

Read-only Postgres SELECT of `snapshots`, `env_build_assignments`, and
`env_builds` linked the sandbox to the same template/build. The build row is
`success`, created 2026-09-22 16:53:27.458+00:00 and marked finished at
16:53:29.048+00:00. In the inspected source, pause records `success` when its
RPC returns, before background upload completion; this DB status is therefore
not a durability proof. The current SDK `Sandbox.get_info` reports the sandbox
`paused` and names its *source* template `f5qw3zn8ykwa7hf8ys7i`; this must
not be mistaken for the failed latest snapshot template `2zow...`.

The separate historical sandbox `ihl0sqg6fzlygwqw357zj` and build
`108a6963-0bb6-4c88-ac61-6a78d66112d6` were initially inspected while
following an earlier failed host probe. They are **not** the build named in
the 41919-descriptor panic and are not combined with D3's artifact set.

## Canonical file manifest

These six files currently exist under
`/var/lib/e2b/storage/templates/4d52ff40-ea41-4b1d-887c-0c000e4a5a8f/`.
Hashes were computed in place; no guest memory or file body was printed or
copied. The metadata JSON was read only for `version`, `template` and
`from_image`, excluding guest environment/commands. It says version 2, build
ID `4d52...`, Firecracker `v1.14-0.2.0`, kernel
`vmlinux-6.1.177_5008931`, base image `debian:trixie-slim`.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `memfile` | 1,772,093,440 | `18e55e014584163ca675879a9b77eb4a0ff4cdc1a0bd81132ebb972d9dcbfc96` |
| `memfile.header` | 1,984 | `0b8a9c4bf14a79de903d0cbef229bc335ed11a2010bd5b8fbea0e268a5233e18` |
| `metadata.json` | 972 | `e09575debd260844943611e23ca560e0b4a0d6bd6f8af1f8dae6cc78b525f47b` |
| `rootfs.ext4` | 206,143,488 | `8a1e2186f260a3d555bec64298b3b67a646093d180efff11afe8b1784c4adfeb` |
| `rootfs.ext4.header` | 410,944 | `31cdd289c484779da169daf12ba390e97e12824a1089ecddc1244cca1c5187fd` |
| `snapfile` | 12,221 | `c3ec635120490929bbbafa6c5ade3a92af0dcf08254f7fd9a6c7c7545abb751d` |

Two surviving local cache directories for that build each contain
`metadata.json` and `snapfile`; both hashes match the canonical files above.
This proves equality for those two small files only. The cache body files,
and file integrity relative to the original pre-reboot values remain
unverified.

## Header dependency graph and preservation

The two exact D3 header sidecars use format V3. A source-derived, read-only
parser in `experiments/e2b-local/inspect-snapshot-header.py` extracted only
build IDs, generations, base IDs and mapping build references. Four synthetic
parser tests passed; the extracted IDs were then checked against canonical
storage. The failed build's memory header has generation 8, base build
`8210f23d-cd5b-409a-8928-91be502a21e5` and four mapped build IDs. Its
rootfs header has generation 23, base build
`dab5cb2b-9a16-4044-be57-2c650748e617` and 22 mapped build IDs.
The memory and rootfs base IDs are different; following only one parent would
miss dependencies.

Following both headers for every referenced build produced a closed set of 23
build IDs. Every header's embedded build ID matched its directory. All 46
canonical memory/rootfs body files exist (12.01 GiB of logical file sizes) and
were hashed in place. All 92 small sidecar files were copied to private ignored
evidence and their hashes match the canonical versions at inspection time. The
remaining linked build `aa57e44b-a616-47c1-92d7-a45d1482688a` was found
through an ancestor header, not directly in the failed build's mapping.

Private evidence under
`app/SiloUI/src-tauri/target/verification/e2b-local/2026-09-23-provenance/d3/`
contains the preserved sidecar tar archives,
`referenced-header-graph.json`, `all-ancestor-body-sizes.tsv`,
`all-ancestor-body-sha256.txt` (manifest SHA-256
`28aab7ed59466eec41859850abc79ba4995575c83b91b657e168bf8e2ecc4ac5`),
and `all-ancestor-sidecar-sha256.txt` (manifest SHA-256
`e458c8c9e337e04ac6a6068632ca69bb8d3e1504281c4f0ce06c37c52c74af3c`).
Raw guest memory/rootfs bodies were not copied to the Mac. Their current hashes
cannot establish what their bytes were before the failed restore, whether the
saved Firecracker device state is internally valid, or whether memory
reconstruction used the intended data. The captured parser source also lacks
verified correspondence to the deployed release.

The raw `/tmp/silo-pause-failure.log` from D2 is absent after the Linux reboot.
Its errno cannot be reconstructed from this D3 inventory.

## Next discriminating work

Compare the parsed graph against the deployed release's header and restore
implementation, then isolate saved device-state bytes from memory mapping
reconstruction using a protected copy. Compare a new, minimal paused-state
control against its post-restart
state only after defining a safe upload/host shutdown barrier. Do not infer a
Firecracker or storage bug from the panic string alone.
