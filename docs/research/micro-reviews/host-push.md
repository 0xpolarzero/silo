# Host push micro-review

Scope: `app/SiloUI/src-tauri/src/host_push.rs` and `app/SiloUI/src-tauri/src/host_push_operations.rs`.

Read-only source review. Checked the two consolidated October 2 reviews and the `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` reports for prior findings. No builds, tests, application launches, or source edits performed.

## HOST-PUSH-1: Post-rename journal errors strand a push that never started

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/host_push_operations.rs:92`, with dispatch at lines 188–191 and deduplication at lines 136–148.
- **Trigger:** The temporary journal is successfully persisted at lines 89–91, then opening or syncing its parent directory fails at lines 92–94. `write` returns an error after the destination file already contains the new `pushing` job.
- **Consequence:** `start` exits through `write(&journal, &jobs)?` before spawning the worker. `start_result` reports failure, but subsequent state reads show the saved job as `pushing` because its session matches the current process. Retrying either the same identifier or a fresh identifier for this repository returns that orphaned job without starting work. Dismissal also refuses it because it is `pushing`. Recovery requires restarting Silo and dismissing the resulting unknown record.
- **Suggested fix:** Handle the post-persist failure as a separate transaction state. Before returning a preparation failure, resolve the visible record to a terminal result that confirms no worker was dispatched, including an in-memory fallback if the terminal write also fails. Preserve safe unknown recovery after a crash and avoid dispatch until the required durability boundary succeeds.
- **Test that would catch it:** Inject a parent-directory sync failure after successful persistence. Assert that no worker runs, status does not remain `pushing`, and a new operation identifier can start the repository without restarting the process.

## HOST-PUSH-2: Free-space cancellation during publication loses the unknown outcome

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/host_push.rs:342`, with the free-space stop at lines 530–532 and final publication at lines 952–962.
- **Trigger:** During the final Git push, GitHub has updated the branch but the client is still waiting for completion. The periodic free-space check then fails, so `HostGit::run` kills the process group and returns `Host push stopped to preserve free disk space.` The stop can also be triggered by a failed `statvfs`, not only depleted space.
- **Consequence:** `final_push_error` converts only cancellation, credential expiry, and step timeout to `PUBLICATION_UNKNOWN`. This host-initiated stop passes through as an ordinary failure, and `finished_result` records `status: failed`. The UI permits another push for a failed operation (`production-source.ts:1651`), although the remote branch can already have changed. The required unknown-outcome acknowledgment is bypassed.
- **Suggested fix:** Preserve structured failure provenance from `HostGit::run` and classify every host-initiated interruption of the final push as unknown. At minimum, include the free-space/status-monitoring stop paths in the existing unknown conversion. Earlier read and LFS stages can retain their ordinary failure behavior.
- **Test that would catch it:** Use a final-push fixture that records a simulated remote ref update and then waits. Inject failure of the periodic free-space check; assert the process is stopped and the completed operation has `status: unknown` with the check-GitHub message. Cover the same injected error before final publication and assert it remains a normal failure.
