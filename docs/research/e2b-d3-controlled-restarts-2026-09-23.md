# D3 controls: orchestrator and clean host restart

Date: 2026-09-23. Scope: one disposable SDK-only guest in the owned
`silo-e2b-diagnostic-d1` VM. The historical `silo-e2b-poc` VM and its failed
D3 snapshot were not changed. The deployed diagnostic orchestrator stayed at
SHA-256
`e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`.
This is a passing control, not a reproduction of the historical virtio panic.

## Exact run and preparation

SDK 2.51.0 run `64a196437b254295af1a4282b506327c` created sandbox
`idwb0vm6hbt7nl23hafns` from the one-CPU, 512-MiB Debian template. Its
initial pause/resume preserved an in-memory HTTP nonce, an acknowledged
fsynced file, and a new write. The source report SHA-256 is
`e6eadf7796f2bb7f23e2811183824a82525d2a38aca2ecadca8a76f4fdb2eb1c`.
The scratch SDK inventory contained only this guest before the later pauses.

For each restart, an exact-run probe checked the guest owner and running
state, verified both oracles, then paused it with memory. It recorded the
pause request before the SDK call, waited for the exact sandbox's orchestrator
upload-success marker and its new catalog build, ran `sync -f` on canonical
storage, and read and hashed the entire header dependency closure. The marker
identified the sandbox; the catalog linked that sandbox's new snapshot to the
build. The source logger's `template.id` field names the source template and
was not used as the snapshot build ID. The guard rechecked these facts and
the unchanged manifest immediately before the host stop.

| Case | New build | Canonical closure | Result |
| --- | --- | --- | --- |
| Orchestrator service restart only | `feb009cc-1190-4c85-80ba-faa413b05119` | 8 V3 builds, 48 objects, 1,730,752,748 bytes; manifest SHA-256 `04c4781c42f1e540d98316dc9653d7101365d3f81a030dc8a138f14e014f0b92` | After `docker compose restart orchestrator`, Linux boot ID stayed `c5104256-5bc7-4128-9c0f-22b4c2c4bddf`; readback hash matched, explicit SDK restore preserved memory and file, and a new fsynced write succeeded. |
| Clean Linux host restart, no cache cleanup | `8f493210-9422-46b2-b152-95a60de57548` | 9 V3 builds, 54 objects, 1,892,550,545 bytes; manifest SHA-256 `67bde11931c9f90a0ddb5f4c315aec6e7aebad9f0f9b74c5b3997e37e26df1b6` | The exact-build host-stop guard passed; Lima stopped and restarted cleanly. Boot ID changed from `c5104256-5bc7-4128-9c0f-22b4c2c4bddf` to `775dc973-52d6-4703-8d87-466bfcd730d3`. Readback hash matched, explicit SDK restore preserved memory and file, and a new fsynced write succeeded. |

The orchestrator verification report SHA-256 is
`ffba4d71314cdab4ca201c0f7c9c2c0c0fcccc435d9a9abe3be3b67918a5bc85`.
The host preparation, guard and verification report hashes are respectively
`66221ec5b347d23f2f0001f41f29f11faafc516c166e4f22ddaffd9dd1f4816f`,
`2a55343f8dbaa4386ada884ed3a859a4c0c07307131e3bc97a33ad2121ec958b`,
and `879e6e90d1af3fc2650a21589370f0f44e04b0ed17faae7708bcf0119de63dee`.
The exact run-owned guest was retired after the reports were saved; the
retirement receipt SHA-256 is
`229049199422d26ea61cdec246a9e4b8bb48aaf3b1c2ebcaab6eecc68264226b`.
Reports and manifests are in ignored
`app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/sdk-lifecycle/`.

The exact host commands were:

```sh
SILO_E2B_DEPLOYMENT=diagnostic-d1 SILO_E2B_HOST_PORT=13801 \
  python3 experiments/e2b-local/poc.py stop-sdk 64a196437b254295af1a4282b506327c
SILO_E2B_DEPLOYMENT=diagnostic-d1 SILO_E2B_HOST_PORT=13801 \
  python3 experiments/e2b-local/poc.py up-sdk 64a196437b254295af1a4282b506327c
```

`stop-sdk` is a separate exact-run path. It permits no other listed SDK
guest or active PoC desktop; it checks the pinned binary, paused state, upload
marker, catalog row and canonical manifest again before Lima stop. The normal
`poc.py stop` and `shutdown.py` guards remain disabled. The old scratch VM
config lacks the later viewer port, so ordinary `up` refused it after the
stop. `up-sdk` restarted the same VM with its unchanged config for this
SDK-only recovery test; it did not add a viewer forward.

## Limit and next discriminator

Both controls passed on one tiny, quiet guest without pressure or cache
cleanup. Neither proves that restore fetched bytes from canonical storage
instead of local cache. Current hashes lack independent pre-incident expected
values, and the captured public source still differs from the deployed
release's dependency set. The historical failed build and its 41919-descriptor
panic remain unexplained. D3 stays **blocked** pending a same-snapshot fresh
cache test on a protected copy, activity/pressure controls, and a source-matched
causal comparison. The clean host control does establish one exact-run recovery
path for this pinned scratch deployment.
