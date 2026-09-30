# E2B PoC qualification gates

Date: 2026-09-23; reconciled against the latest evidence on 2026-09-24. Candidate: pinned Embed Compose inputs
at public runtime revision `a065a4ddb3f2c6a4149634d9acb14b62f65839ac`, on an
owned M4 Max macOS host with a separate Ubuntu 26.04 ARM64 Lima VM. The
historical `silo-e2b-poc` VM was inspected read-only; local experiments ran on
the separate `silo-e2b-diagnostic-d1` VM. Later remote tests used the native
Linux x86-64 devbox described in Gate H. The public source revision is
**not** proven to match the deployed API/orchestrator binaries. No SiloUI
product code changed. Late-session results are in
[causal bounds](e2b-causal-bounds-2026-09-23-late.md); two upstream
reports were filed from release-binary evidence:
[e2b-dev/runtime#3658](https://github.com/e2b-dev/runtime/issues/3658)
(failure-path data loss on pause/checkpoint) and
[e2b-dev/runtime#3659](https://github.com/e2b-dev/runtime/issues/3659)
(an unrestorable successful snapshot captured during storage exhaustion; the exact capture mechanism remains unknown). Both issues were checked open on 2026-09-24.

Investigation status describes causal knowledge. Execution status is `passed`,
`failed`, `not run`, or `blocked` for the full gate; a passing subcase does not
change a blocked gate to passed.

| Gate | Investigation status | Execution status | Evidence and remaining condition |
| --- | --- | --- | --- |
| P0 provenance | Current binaries, OCI digests, Go build metadata and 2,568-file source manifest captured. The D2 actual-fsync reproduction ran on the **pinned release binary itself**, removing the source-build caveat for that case. | blocked | [Provenance audit](e2b-provenance-audit-2026-09-23.md), [release-source mapping](e2b-release-source-mapping-2026-09-23.md); exact incident-time source and release build mapping remain required for D1/D3 attribution. |
| D1 checkpoint | **Release-binary reproduction with a real allocator failure:** exhausting reserved hugepages made the pinned binary's checkpoint fail at the exact historical boundary with a genuine kernel `ENOMEM` (`error resuming sandbox after checkpoint: … mmap memfd: cannot allocate memory`), followed by the full preservation failure (source unaddressable, failed build, local-only artifacts, restore 404). Together with the exact-ID runs, the defect now reproduces at two boundaries on a source build **and** with a real ENOMEM on the release binary. Incident-time source/flag mapping and an after-fix regression remain open. | blocked | [Causal bounds](e2b-causal-bounds-2026-09-23-late.md): hugepage run `ac86384031c84816ac1297a34fc33d29`, exact-ID pair `16f2d77d…`/`29f28a3d…`, post-capture pair `280a431d…`/`a0fdce09…`; reported on [e2b-dev/runtime#3658](https://github.com/e2b-dev/runtime/issues/3658#issuecomment-5799997670); no upstream fix yet. |
| D2 pause | Release-binary reproduction (2/2, actual kernel `fsync` EIO at the real boundary) stands; the **physical trigger is now documented**: the host filesystem was demonstrably full from 17:56 (contemporaneous ENOSPC wall in the journal, which also explains the journal gap), and a bounded loopback-ext4 probe excludes plain ENOSPC as the EIO mechanism (it yields ENOSPC at write with clean fsync) — the EIO came from a deeper mode under that pressure, no longer distinguishable from retained logs. ENOSPC/upload-failure variants of the propagation test remain unrun. Filed as [e2b-dev/runtime#3658](https://github.com/e2b-dev/runtime/issues/3658) with the context comment. | blocked | [Causal bounds](e2b-causal-bounds-2026-09-23-late.md): fault runs `bf19ecc9a6bc423ba010df4032d2a8d9`, `4dcd6f6049ef45cb8aed058d91ad3f39`; physical-cause receipts in the historical journal window; the host-shutdown durability barrier is now qualified (Gate R); failure-preservation repair and ENOSPC/upload-failure propagation cases remain. |
| D3 restore | **Root cause identified at artifact level:** the failed snapshot's 23-build/12.01 GiB closure was protected-copied (46/46 hashes verified), placed in the diagnostic deployment, and restored through the production path — the exact 41919-descriptor panic reproduces **3/3** on a healthy host; the immediately preceding generation (18:11 capture) restores cleanly and boots. The corruption entered at the 18:53 capture, 57 minutes into the documented full-disk crisis (same window as D2). Restore-time assembly, our cache reclamation, host hardware and the restart are excluded. Which side is stale (memfile ring bytes vs snapfile device state) remains open behind E2B's private fork vmstate schema. Filed as [e2b-dev/runtime#3659](https://github.com/e2b-dev/runtime/issues/3659). | blocked | [D3 root cause](e2b-d3-root-cause-2026-09-23.md), [causal bounds](e2b-causal-bounds-2026-09-23-late.md); receipts under `evidence/d3-root-cause/` plus the protected copy `d3-protected-copy/`; remaining: the stale-side identification (needs fork schema or maintainer input) and an upstream fix. |
| A adapter | Live checks complete: concurrent checkpoint+pause serialize with truthful status; a SIGKILL landing **inside** an in-flight checkpoint (client saw `RemoteProtocolError`) reconciled to a truthful `running` record with the desktop unharmed; killing the desktop's Firecracker by exact PID made screenshots fail 500, pause fail 502, and the record reclassify to `missing` instead of lying; delete by exact ID tombstones cleanly. `Sandbox.connect()` on a stopped sandbox auto-creates a new runtime (observed live) — the adapter must never poll via connect. | blocked | `evidence/gate-a-live/{f07a5e10,352e5538,283fc738,26371ea8}*.json`; remaining: upstream fixes (#3658/#3659) so failures don't destroy state at all. |
| C credentials | Synthetic two-workspace Bearer/Basic, Git/LFS, rotation and current-grant-after-revert cases passed. The separate real-provider matrix passed 9/9; the policy-layer real-provider revocation harness passed 6/6, including denied restored-guest replay with zero provider egress. These do not qualify the selected replacement broker in an E2B guest. | blocked | [Provider evidence](e2b-real-provider-qualification-2026-09-24.md), [tool selection](e2b-credential-tools-2026-09-24.md). Qualify iron-proxy first against the existing contract, required GitHub App/PAT authorization and GraphQL behavior, owner-store lifetime, real guest routing and current grants after restore. The [later assessment](e2b-viewer-input-root-cause-2026-09-24.md#reclassification-the-human-keypress-is-a-confirmation-not-a-required-input) treats a second real PAT rotation as optional composition coverage, not a user-input blocker. |
| T access | SSH bridge half-close/frame-limit tests, SDK transport fixtures, and fresh desktop PTY/SSH/SFTP cases passed. An interrupted upload left 65,536 remote bytes. | blocked | [Access audit](e2b-access-viewer-audit-2026-09-23.md), [fresh run](e2b-fresh-desktop-qualification-2026-09-23.md); native Zed/VS Code save, PTY network loss, lifecycle interruption and publication/revocation remain. |
| V viewer | Raw RFB pointer/key delivery and modifier-correct DOM input through WKWebView passed. A production-version-matched, zero-capability Tauri harness delivered Ctrl+S and rejected a viewer IPC probe. Two-viewer ownership handoff and immediate epoch invalidation passed; tickets survive control-service restart to TTL, accepted by the user. | blocked | [Viewer evidence and reclassification](e2b-viewer-input-root-cause-2026-09-24.md). Hardware-keypress confirmation is optional, not a user-input blocker. No full pass is recorded for the requested clipboard/layout/focus/drag/resize matrix or Linux WebKitGTK. The previously rejected observer-input experiment remains unmeasured; role routing is proven but does not substitute for that denial test. |
| R operations | Full desktop durable pause → host shutdown → restart → resume passed with marker and 100 MiB payload intact. After fixing the suite cleanup path, a fresh 9/9 run left zero desktops; the last recorded deterministic suite passed 97 tests. Template deletion through the API retained 44 GiB until manual closure-verified removal. Pause holds the registry lock during its bounded upload wait, potentially stalling unrelated reads. | blocked | [Latest work-log entries](e2b-qualification-worklog-2026-09-23.md#2026-09-24-final-suite-self-cleanup-fixed-and-live-verified-tauri-viewer-surface). Remaining: supported retention/reclamation with live descendants, measured capacity/admission under concurrency, responsive control reads during durability waits, interruption/retry of deployment and runtime updates, and preservation under disk/upload failures. Suite cleanup and the shutdown barrier are resolved. |
| H platforms/remote | A Mac controller and native x86-64 Linux/KVM owner passed create, client disconnect, durable pause/resume, checkpoint/restore and remote orchestrator restart. This used small SDK guests, not the complete desktop/editor workflow. Default Ubuntu UFW blocked guest forwarding and redirected proxy input. | blocked | [Two-computer evidence](e2b-gate-h-two-computer-2026-09-24.md). Complete x86-64 desktop/viewer/editor/file flows, full owner restart with current grants and stale sessions, and narrow installer firewall rules. M3/lower-memory macOS and the rest of the promised platform matrix remain unrun; do not infer them from M4 Max or nested ARM64 evidence. |
| I integration | Fresh desktop/synthetic Git runs passed 9/9; the latest also verified automatic exact-run cleanup. The last recorded deterministic suite passed 97 tests. The report contract enumerates six desktop plus three credential cases, not all adoption gates. | blocked | [Work log](e2b-qualification-worklog-2026-09-23.md), [case contract](https://github.com/0xpolarzero/silo/blob/c122a498da064f08321c29bff82a6e92056a917d/experiments/e2b-local/report_contract.py). After fixes, pin runtime/template/broker/adapter inputs and run all required cases plus a bounded repeated lifecycle/concurrency run with resource and survivor oracles. Historical passing subsets cannot be combined into a final candidate verdict. |
| S scope/review | User accepted files-only export, restart-to-apply CPU/RAM changes and viewer TTL survival on 2026-09-24. Keep Silo familiar; checkpoint revert/fork remain distinct; host-only lifecycle controls are not approved. No production cutover or LCU rewrite is authorized. | blocked | [Replacement plan](../archive/SiloUI-E2B-REPLACEMENT-PLAN.md). No user input is currently needed for independent qualification work. Upstream fixes are not the only remaining work: complete the unrun rows below and above, then present concrete visible changes before UI implementation. |


## Accepted behaviors that still need PoC evidence

These decisions change required behavior; agreeing to them is not an executed pass.
No end-to-end receipt for either flow was found in the current PoC or later work log.

| Behavior | Qualification before integration |
| --- | --- |
| Files-only export/import | Standard archive plus manifest; fresh-host import into a current template with exact bytes, filenames, modes, symlinks and uncommitted work. Exercise cancellation, corrupt archives and traversal rejection. Do not claim to preserve installed packages or process memory. |
| CPU/RAM restart-to-apply | Change a workspace's profile through a supported cold-restart path; verify its files, retained checkpoints and logical identity survive, old running processes do not, and a failed replacement leaves recoverable state. Memory-snapshot resume alone does not prove resource reconfiguration. |

## Meaning of fully qualified

Before the Silo refactor, each required backend seam must have executed evidence
on the selected deployment, or an explicitly accepted scope reduction. Finish
native editor save/reconnect, PTY/files and HTTP/HTTPS/WS/raw-TCP interruption and
revocation; remaining viewer interaction/security cases; storage, resource,
export and update paths; and the promised host/remote workflows. Review selected
network policy against the required sibling/host/metadata and IPv4/IPv6/DNS
boundaries rather than generalizing the existing selected-destination probes.
Use maintained upstream mechanisms first, including for transport and storage.

Then freeze the candidate and run the combined qualification with bounded repeats
and independent bytes/process-state/access-denial/cleanup oracles. Keep the LCU
seam and desktop readiness; deeper computer-use qualification remains deferred
while LCU is being rewritten.

Actual Silo navigation wiring, final packaged-app end-to-end acceptance, signing,
installer/updater distribution checks and removal of legacy bundle contents
belong to integration/release verification. They cannot already have passed in
the standalone PoC. The PoC must prove their underlying runtime contracts first.

Local verification command:

```sh
/tmp/silo-e2b-qualification-tests/bin/python -m unittest discover -s experiments/e2b-local -p 'test_*.py' -q
```

The last recorded deterministic suite passed 97 tests on 2026-09-24; this
reconciliation did not rerun it. Latest live results and evidence locations are
in the linked work log. Real-provider and two-computer subsets are now executed,
while D1–D3 repair, full native access, operations, platform coverage and the
final combined qualification remain open. No runtime, VM or Silo product code
was changed while reconciling this matrix.
