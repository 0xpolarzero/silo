# Desktop micro-review and fix

Scope: `app/SiloUI/src-tauri/src/desktop.rs`.

## DESKTOP-1: Queued desktop actions can target a replacement VM

- **Priority:** P2.
- **Original location:** `desktop.rs:607` and `:619`; remote dispatch discarded the request ID at `:578`.
- **Trigger:** A desktop action captures VM A's ID and waits behind a computer-wide configuration operation that replaces A with VM B under the same name. After admission, the action resolves the name again and accepts B's metadata and runtime labels.
- **Consequence:** An action for A can mutate B while holding A's operation gate. Converting a remote request's explicit ID to a name before admission also permits retargeting.
- **Suggested fix:** Preserve the expected stable ID through admission and reject a changed identity before runtime access. Preserve the explicit ID on remote desktop and approval requests.
- **Regression:** Hold a computer gate, queue an action for A, replace the metadata with B under A's name, and release the gate. The action must fail without accessing the runtime. Also reject an explicit stale ID and preserve admission of unchanged VMs and ungated status reads.
- **Disposition:** Fixed and folded in `80ea0e95`. Includes a patch changeset.

## Verification

The failing diagnostic used the actual `prepare_local` and `machine_at` function bodies, the real operation gate and scripted runner, and synthetic metadata/runtime adapters. It reproduced acceptance of B's ID. After the fix, all three diagnostic regressions passed.

The complete native test harness was compiled from this worktree with Rust 1.94.0 against the shared cached dependencies, using the documented synthetic GitHub values. All 23 `desktop::tests::` tests passed, including the three new regressions. This compilation used the existing Tauri build outputs and restored generated schemas locally. The normal focused Cargo command remained blocked on the shared artifact lock and was terminated after verifying that it was this worktree's own waiting process; it is not recorded as a passing Cargo run.

Evidence and the exact diagnostic/compiler commands are retained under `/tmp/silo-codex-target/verification/desktop/` (`diagnostic.py`, `native-check.py`). Failure and success logs are `/tmp/silo-desktop-diagnostic-before.log`, `/tmp/silo-desktop-diagnostic-after.log`, and `/tmp/silo-desktop-native-after.log`. These are local verification artifacts, not distribution binaries.

`cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`, `npm --prefix app/SiloUI run typecheck`, `npm --prefix app/SiloUI run lint`, and `git diff --check` passed. Frontend checks used Node 24.11.1. No app bundle was inspected or launched, and no live VM, production data, or real GitHub configuration was used.

After folding, the integration merge changed neither `desktop.rs` nor the operation gate; the three diagnostic regressions passed again. The remaining scope review established no additional separate finding.

## DESKTOP-2: Fresh runtime observations lose the captured identity

- **Priority:** P2.
- **Location before fix:** `desktop.rs:378` and `:768`.
- **Trigger:** The runtime sandbox is replaced between initial machine resolution and the later status or approval inspection. The later inspection can also return an unmanaged sandbox or a different name.
- **Evidence:** `status_with` checked only runtime state before reading the guest or returning a stopped fallback. `approval_at` likewise used only `Running` before saving policy. Native regressions reproduced acceptance of a stopped replacement, acceptance of unmanaged/renamed observations, and persistence of Auto approval for a replaced runtime. All three failed before the fix.
- **Consequence:** A replacement's state can be reported for the original VM, and approval changes can be saved after the selected runtime identity is gone. A running replacement also reaches the guest status command because its labels were not checked.
- **Fix:** Reuse the existing ownership, name, and stable-ID checks for every fresh desktop runtime inspection, before guest access or approval persistence. Pending restores retain their existing stopped behavior. This validates observed identity; it does not make an ungated guest read atomic with subsequent runtime changes.
- **Regression:** Resolve A, return B from the next inspection, and reject the status without a guest command. Reject unmanaged and renamed observations. Reject approval before writing its policy. Existing stopped/running fixtures now carry the real ownership labels required by production.
- **Verification:** The complete cached-dependency native harness runs `desktop::tests::` with synthetic GitHub configuration and temporary fixtures. Before-fix output is `/tmp/silo-desktop-2-before.log`; after-fix output is `/tmp/silo-desktop-2-after.log`. No app or live VM was launched. After the fix, all 27 desktop tests passed, as did Rust formatting, frontend typecheck/lint, and whitespace checks.
