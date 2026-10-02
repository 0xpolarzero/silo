# Runtime directory micro-review: runtime-dir-a

Scope: first five of fourteen recursively listed files, sorted alphabetically (first third rounded up):

- `app/SiloUI/src-tauri/src/runtime/checkpoints.rs`
- `app/SiloUI/src-tauri/src/runtime/checkpoints/native.rs`
- `app/SiloUI/src-tauri/src/runtime/checkpoints/running_retry_tests.rs`
- `app/SiloUI/src-tauri/src/runtime/configuration_recovery.rs`
- `app/SiloUI/src-tauri/src/runtime/contract_tests.rs`

Read-only source review. No builds, tests, app launches, or live data access. Checked the first two comprehensive reports and local `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` for duplicates.

## RUNTIME-DIR-A-1: Fork rollback destroys recovery state after inventory publication

**Priority:** P2.

**Location:** `app/SiloUI/src-tauri/src/runtime/checkpoints.rs:1548`, rollback at lines 1553–1564. Supporting persistence contract: `app/SiloUI/src-tauri/src/runtime.rs:5992`–6004.

**Trigger:** Creating a fork successfully replaces the metadata file, then opening or syncing the metadata parent directory fails. `write_metadata` performs `temporary.persist(path)` before that fallible directory sync, so its error does not imply that the previous inventory is still present.

**Evidence:** `fork_commit` appends the child and calls `write_metadata`. Every returned error runs assignment cleanup and `forget_removed(paths, &child_id)` without removing the child from published metadata or checking whether publication happened. `forget_removed` deletes the child's checkpoint record and computer-use settings (`checkpoints.rs:801`–811). Missing checkpoint records load as `Record::default()` (`checkpoints.rs:99`–101). The existing `a_failed_inventory_write_removes_the_fork_record_and_assignments` test (lines 4823–4846) makes the parent unwritable, which fails before publication and does not exercise this branch.

**Consequence:** The inventory retains a configured child with no runtime VM, while rollback deletes its pending checkpoint selector, desired network policy, and copied assignments. Subsequent explicit Start no longer selects `start_pending`, because its missing record has no pending restore; the fork cannot start through its intended checkpoint path. Retrying the same fork name fails the inventory name check. The source checkpoint remains intact, but the child has lost its durable link to it.

**Suggested fix:** Make metadata publication outcome explicit at the persistence seam. After a post-publication durability error, preserve the child's dependent state and report the durability failure, or durably restore the previous inventory before deleting dependencies. Do not interpret every write error as proof that no metadata changed.

**Test that would catch it:** Inject a failure specifically after successful metadata replacement and before successful parent-directory sync. Call `fork_commit` with fixture paths and fake assignments. Assert that every child still present in metadata retains its pending checkpoint record and assignments; if rollback is chosen, assert that the child leaves metadata before its record is deleted. Keep the existing pre-publication failure regression.
