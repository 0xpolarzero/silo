# Remote directory follow-up fixes

Scope: `remote/operations.rs` and adjacent remote request modules, continuing the review on `codex/fix-remote-dir-b` after merging `codex/integration`.

## remote-dir-b-2: Guest key preparation targets a same-named replacement

**Priority:** P2.

**Original location:** `app/SiloUI/src-tauri/src/remote_access.rs:63–78` at `94de915b`, the `guest.prepare` dispatch branch.

**Trigger:** A request names VM A's immutable ID. The owner resolves A's name and queues guest key preparation behind a computer-wide operation. That operation replaces A with B under the same name. A replacement between the initial ID lookup and the subsequent name-to-ID lookup also causes retargeting before queueing.

**Evidence:** Dispatch converted the request's ID to a name, resolved that name back to an ID for the gate, and used the cached name after admission without comparing identities. The extracted admission helper preserves those original steps before correction. Two native regressions failed: a queued same-name replacement was accepted, and an explicit stale request ID was accepted when B already owned the name. An unchanged-A control passed.

**Consequence:** The request can inspect B and authorize the controller's SSH key in B instead of A. The queued case also runs under A's gate while accessing B.

**Fix:** Acquire the turn using the request's explicit ID and compare fresh metadata with that ID after admission. Reject a replacement before inspecting the guest or authorizing the key. The concrete `guest_access_turn` helper provides this admission seam without changing the request protocol.

**Regressions:** `queued_guest_access_rejects_a_same_named_replacement`, `guest_access_rejects_a_stale_explicit_id_before_admission`, and `guest_access_admits_the_requested_vm` in `remote_access.rs`.

**Verification:** The complete native test harness compiles from this worktree with Rust 1.94.0, cached dependencies and generated Tauri schemas, and explicit synthetic GitHub configuration. Both replacement regressions failed before the fix; all four remote-access fixture tests pass after it. Full native Clippy metadata compilation succeeds with existing warnings outside the changed module; Rust formatting and whitespace checks pass. Only the remote-access fixture tests run; no app, live VM, real credential store, or production HOME is used. Compiler commands and before/after evidence are retained under `/tmp/silo-codex-target/verification/remote-dir-b-round-2/`.

## remote-dir-b-3: Expired remote changes open another SSH connection

**Priority:** P2.

**Original location:** `app/SiloUI/src-tauri/src/remote.rs`, `send_change`, at `af59d352`.

**Trigger:** An SSH attempt consumes the remaining request budget, then reports a lost connection. An already-expired request also enters this path without a deadline check.

**Evidence:** The retry-delay decision reused `remaining` from before the exchange. The native regression recorded two sends when the first attempt exhausted the deadline. A second exact-source regression recorded one send for an already-expired request, instead of zero.

**Consequence:** Silo opens an unnecessary SSH connection and delays failure after its request deadline. A completed change may be attached again after the controller's waiting budget ended.

**Fix:** Reject an expired budget before each send and recompute the remaining budget after a lost connection before deciding to wait and retry. Keep the original operation identity and final connection error.

**Regressions:** `a_lost_change_that_exhausted_its_deadline_is_not_sent_again` and `an_expired_change_never_opens_a_connection`. Existing stable-identity, retry-limit, terminal-error, and shutdown-generation controls remain covered.

**Verification:** Both new regressions fail before correction and pass in an exact-source retry harness with the two existing retry controls. This fixture harness uses production error and shutdown admission code, cached Rust dependencies, and a private isolation mutex. The complete native harness also passes all four focused retry tests. Native Clippy metadata compilation succeeds with existing warnings; Rust formatting and whitespace checks pass. Full native compilation and focused native checks use synthetic GitHub configuration; evidence is retained under `/tmp/silo-codex-target/verification/remote-dir-b-round-2/`. No SSH server, app, live VM, production HOME, or real credentials are used.

**Integration verification:** The fold conflicted with the checkpoint retry clock seam. Both deadline checks now use that clock. All four retry controls pass against the merged helper, and both existing checkpoint completion/reconnect regressions pass with the actual owner registry and gate admission code in an isolated fixture harness. Production Clippy metadata compilation and formatting pass. Recompiling the merged full native test harness is blocked by the cached Tauri dependency lacking its newly required `test` feature in an unrelated settings test; the earlier full native test results above precede that merge.

**Final integration build attempt:** A coherent cached Tauri test dependency graph became available. The complete native harness was attempted again after merging integration, most recently at `5a961950`, but compilation fails at `host_push.rs:1158`: `vm_id` is not defined in the publication function. The exact failing output is retained in `native-final-current.log`. This unrelated integration defect prevents a final whole-crate test result; the earlier native and merged isolated fixture results remain the validation for these fixes. No production data or live service was used.
