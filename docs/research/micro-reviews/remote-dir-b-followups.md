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
