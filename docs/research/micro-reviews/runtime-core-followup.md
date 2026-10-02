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
