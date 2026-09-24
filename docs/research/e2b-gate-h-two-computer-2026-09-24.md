# E2B two-computer and native-Linux qualification (Gate H)

Date: 2026-09-24. Second machine: the user's locally connected Linux box
(`devbox`, 10.77.77.2) — bare metal, Ubuntu 26.04, **x86_64**, kernel
7.0.0-31, 16 vCPU, 15 GiB RAM, real `/dev/kvm`, Docker 29.7.2. Controller:
the Mac (SDK from the PoC environment). Raw reports under
`deployments/diagnostic-d1/evidence/gate-h-remote/`.

## Deployment (fresh-host gate)

The pinned Embed Compose inputs (compose.yaml `0ef4902d…`, .env `58f80d93…`
+ `HUGEPAGES=2048`) deployed on bare metal without Lima. Three host findings:

1. **UFW breaks guest networking two ways** on a default Ubuntu server: the
   FORWARD policy DROP kills guest egress, and redirected guest TCP (E2B's
   firewall proxy on ports 5010-5018) dies in the INPUT chain. Fixes applied
   for the test (DEFAULT_FORWARD_POLICY=ACCEPT + allow rules for
   169.254.0.0/24, 10.11.0.0/16, 10.12.0.0/16), all reverted at teardown.
   The Lima path never sees this because that VM has no ufw — a real
   deployment-environment gap for the install recipe.
2. The pinned images and kernels are multi-arch: the base template built on
   x86_64 in 35 s with no changes.
3. Preflight enforces ≥20 GiB free (matches `PF_MIN_FREE_GIB`).

The API is loopback-bound on the host; the Mac reached it through an ssh
tunnel (`-L 13803:127.0.0.1:3000 -L 13804:127.0.0.1:3002`) with
`E2B_API_URL`/`E2B_SANDBOX_URL` overrides — the team key never left the
loopback path.

## Results (controller on Mac, execution host on devbox)

Run `6d81f84fcc7842e79a4b1f234f17087a` (template `silo-sdk-gateh-x64` built
remotely in 32 s, 1 vCPU / 512 MiB guests, SDK 2.51.0):

| Case | Result |
| --- | --- |
| Create | **x86_64 guest, kernel 6.1.177+** — first bare-metal non-ARM64 execution in this project |
| Controller disconnect (client dropped 45 s) | sandbox still `running`; oracles preserved on reconnect |
| Pause + upload-marker barrier + resume | marker in 0.6 s (host-side log check over ssh); oracles preserved |
| Checkpoint + restore from snapshot | new sandbox from `kbk0ozbcnescouexmabw:default`; oracles preserved |

Run `fa492ab857944dff88b01e64bea1aac6` (restart case, after the first
attempt hit the known placement-readiness race — the node needs ~seconds
after orchestrator restart before it can place):

| Case | Result |
| --- | --- |
| Pause (marker verified) → orchestrator restart on the remote host → resume | guest state intact (`gate-h-restart` marker + new post-restart write) |

## What this establishes

- Two actual computers, controller-on-Mac / execution-host-on-Linux: create,
  oracles, disconnect-resilience, durable pause, checkpoint/restore, and
  remote-host service restart all pass.
- The pinned runtime runs on **native Linux x86_64 with bare-metal KVM** —
  architecture portability of images, kernel, Firecracker and lifecycle is
  demonstrated for this revision (memory snapshots were not migrated
  cross-arch; each host used its own templates).
- Local Mac-side client shutdown leaves the remote host untouched (the host
  ran sandboxes with no Mac state beyond the ssh tunnels; tunnels were torn
  down at teardown).

## Limits

- The devbox was reverted at teardown (compose down, ufw restored from
  backup, hugepages zeroed); `/var/lib/e2b` and `~/silo-e2b-gateh` remain on
  that machine — the compose `purge` profile removes them fully if desired.
- Owner-restart with live credential/session revocation and stale-session
  denial were not exercised (PoC control plane runs on the Mac; bringing the
  full PoC to the second machine is future work).
- Desktop (GUI) flows on x86_64 untested; only the small SDK template.
