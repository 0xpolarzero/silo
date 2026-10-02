# Bundled help review

Scope: `app/SiloUI/docs/silo-help.html`, checked against current frontend and native implementation. Read-only source review; no app launch, builds, or tests. Checked both earlier review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md`; excluded the previously reported full-checkpoint import mismatch (R-28).

## USER-DOCS-1 — P3 — Checkpoint deletion instructions omit the owning-computer requirement

- **File:line:** `app/SiloUI/docs/silo-help.html:18`.
- **Trigger:** Connect another computer, open one of its sandboxes' Checkpoints tabs, and follow “Delete checkpoint data through Delete… in the checkpoint's actions menu, then confirm.” The help's checkpoint instructions cover connected sandboxes and qualify Export as local at line 17, but give no such restriction or alternative for Delete.
- **Evidence:** `app/SiloUI/src/features/application/components/checkpoint-panel.tsx:58` defines local as `!workspace.computer`; lines 268–269 include the Delete item only for local sandboxes. `app/SiloUI/src/desktop/production-source.ts:1508` explicitly rejects remote deletion with “Delete checkpoints of this sandbox in Silo on its own computer.” This is an intentional product restriction, not an offline-state failure.
- **Consequence:** Users following the bundled help cannot find the instructed action for connected sandboxes and receive no instruction to switch to the owning computer to remove checkpoint data.
- **Suggested fix:** Qualify checkpoint deletion as local and tell users to open Silo on the sandbox's owning computer to delete its checkpoints.
- **Test that would catch it:** Render the Checkpoints panel with a connected-computer fixture and assert that Delete is absent while Fork and Restore remain available; check that the bundled help explicitly directs remote checkpoint deletion to the owning computer. Include a local fixture with a deletable checkpoint as the positive control.
