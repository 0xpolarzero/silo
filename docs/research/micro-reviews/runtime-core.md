# Runtime core micro-review

Scope: `app/SiloUI/src-tauri/src/runtime.rs`. Read-only source review; no builds, tests, application launches, or live data access. Checked the first and second review reports in the main checkout and the existing third-pass reports for duplicates.

## RUNTIME-CORE-1: Resource edits adopt a same-named replacement VM

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/runtime.rs:5670–5704`; configuration preflight at `5114–5119`; ownership predicate at `4686–4700`.
- **Trigger:** Saved metadata identifies VM `dev` as UUID A, but the runtime's same-named VM has `silo.managed=true` and `silo.machine-id=B`. Submit a CPU or memory change for A with no interrupted configuration journal. This is the replacement condition that deletion and lifecycle operations already reject.
- **Evidence:** The configuration preflight calls only `ensure_managed`. `update_machine` repeats that check, which requires a nonempty name and the managed label but does not compare the machine ID. A Running replacement is stopped at line 5675; a Stopped replacement proceeds directly to `modify`. That command writes `silo.machine-id=A` at line 5704. The post-update `verify_machine_configuration` checks ownership and resource/mount values, not the original identity. `configuration_recovery::prepare_retry` performs reconciliation only when a journal exists, so it supplies no identity check for a fresh edit. By comparison, `preflight_removal` at lines 5765–5775 and `lifecycle_recovery::inspect` explicitly reject a different machine ID.
- **Consequence:** Editing A stops and changes B, then overwrites B's stable identity with A. With matching storage sizes, verification accepts the result and commits the edit. The replacement also becomes eligible for later operations, including deletion, under A's identity. This is a correctness and preservation defect, not a claimed host security boundary.
- **Suggested fix:** Before any update side effect, require the inspected name and `silo.machine-id` to match the saved machine. Repeat that validation after stopping and before modification. Apply the same check before the desktop-only update branch.
- **Test that would catch it:** Use the existing stub runtime seam with saved A and an inspected `dev` carrying valid UUID B and the managed label. Submit a resource edit with no recovery journal, once with B Running and once Stopped. Both must reject without any `stop`, `modify`, or guest `exec` call and leave metadata unchanged. Keep a matching-A case that successfully applies the edit.
