# Runtime core follow-up

Scope: `app/SiloUI/src-tauri/src/runtime.rs` and adjacent runtime helpers. Synthetic fixtures only; no app, real VM, credential store, or production state was accessed.

## RUNTIME-CORE-2: GitHub access updates trust a replacement's name

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/runtime.rs`, `apply_github_policy_with`, identity resolution and inspection before `spawn_runtime`.
- **Trigger:** An update resolves saved VM A, then a configuration operation replaces it with same-named B before admission; alternatively, saved A already disagrees with runtime B's `silo.machine-id`.
- **Evidence:** Admission used A's stable ID, but subsequent inspection checked only `silo.managed=true` and `silo.github-protocol=1`. The function then read secret material, sent the profile to a name-targeted `modify`, and cached it as applied. An extracted, unchanged production function with synthetic adapters accepted both replacement cases; both rejection assertions failed while the matching-ID control passed.
- **Consequence:** GitHub credentials and general secret material intended for A can be sent to B, with the update reported as successful.
- **Fix:** Retain the original stable ID, revalidate fresh metadata after admission, and require the inspected runtime name and ID to match before reading secret material or launching `modify`.
- **Regression coverage:** Native tests cover a mismatched runtime ID and a same-named metadata replacement while admission is blocked. Existing fake-runtime successful-update cases now supply their saved machine ID. The extracted fixture passes all three cases after the fix; Rust formatting, frontend typecheck, lint, and whitespace checks passed. The focused native Cargo run was queued on the shared artifact-directory lock when this record was written; no native compilation result is claimed.

## RUNTIME-CORE-3: Git identity work accepts a same-named replacement

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/runtime.rs`, `configure_workspace_identities_in` and `verify_workspace_identities_in`.
- **Trigger:** Runtime B has the same name as saved A, or a configuration operation replaces A while identity work waits for its VM lane. The runtime can also change between configuration preflight and admission while metadata still names A.
- **Evidence:** Configuration inspected before admission and checked only the managed label; it never inspected again inside the lane. Verification likewise checked ownership without comparing the stable ID. The unchanged production functions failed five rejection cases in the extracted fixture while the matching-ID control passed.
- **Consequence:** Configuration clears boot identity overrides and writes Git/jj defaults into B. Verification can report B as satisfying A's identity setup.
- **Fix:** Compare the runtime name and ID at preflight, revalidate current metadata after admission, and inspect the runtime again inside the configuration lane. Verification performs the same identity checks before guest execution.
- **Regression coverage:** Three native regressions cover mismatched runtime IDs, replacements committed during admission, and a runtime replacement after preflight. Existing matching-ID fixtures retain successful configuration, verification, stopped-VM handling, and one-VM-at-a-time admission. All six extracted cases pass after the fix; Rust formatting and whitespace checks passed. Full native verification remains queued on the shared Cargo lock.

## RUNTIME-CORE-4: Secret application continues under a removed VM's lane

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/runtime.rs`, `apply_secrets` admission and the guest-policy application closure.
- **Trigger:** Saved A is replaced by same-named B while secret application waits for A's gate, or runtime B already disagrees with saved A.
- **Evidence:** The application retained A's gate ID but read desired secrets and called `secrets_runtime::apply` by name afterward. That helper validates ownership, status, and HTTPS handling but does not compare the stable ID. An extracted, unchanged application closure accepted both replacement cases and read material/applied policy; both rejection assertions failed while the matching-ID control passed.
- **Consequence:** A stale update can send secret material to a different runtime VM and perform work on B under A's admission lane.
- **Fix:** After acquiring runtime access, require current metadata to retain the originally admitted ID and require the inspected runtime to match it. Reject identity failures as final before reading secret material. A path-based seam keeps the public AppHandle wrapper unchanged in behavior and permits isolated unit coverage.
- **Regression coverage:** Native fixtures cover a runtime mismatch, a saved replacement while admission is blocked, and successful matching-ID application using an explicitly synthetic secret document/vault. The three extracted cases pass after the fix, including the resumed run. Rust formatting, TypeScript typecheck, lint, and whitespace checks pass. The resumed focused Cargo run (`secret_apply_`) waited on the shared artifact lock and was interrupted after verifying its PID and worktree; native fixtures remain unverified. The earlier native attempt failed on unrelated settings test compilation.
