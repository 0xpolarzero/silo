# Frontend library and hooks micro-review

Scope: `app/SiloUI/src/lib/` and `app/SiloUI/src/hooks/`.

Read-only source review, including production call sites and existing tests. No builds, tests, or live application operations were run. Checked the first, second, and local third-pass review reports for prior findings; the defects below were not reported there.

## FE-LIB-HOOKS-1: Reused toast IDs retain ownership of previous sandboxes

- **Priority:** P3
- **File:line:** `app/SiloUI/src/lib/operation-toast.ts:65–79` (also dismissal at 147–149).
- **Trigger:** Import sandbox A successfully, dismiss its result, then export sandbox B and delete A while B's export result remains visible. The transfer component uses `backup-operation` for every import/export (`features/application/components/computer-transfer.tsx:10,127,161`). Import success tags that ID with A; dismissing it does not remove the tag. Later export progress/result supplies no sandbox and `tagSandbox` returns without removing A's association. Deletion cleanup calls `dismissSandboxToasts(A)` (`features/application/pages/overview-page.tsx:540–549`).
- **Consequence:** Deleting A dismisses B's unrelated export result, including its Show in Finder action. The same problem occurs when a replacement explicitly belongs to another sandbox: registration only adds ownership, never replaces it. Closed notifications also remain in the registry until their sandbox is deleted.
- **Suggested fix:** Track the current owners of each toast ID. Replace ownership when an ID is rendered again, including when the new owner is undefined, and remove ownership on explicit dismissal, user dismissal, and automatic closure while preserving caller callbacks.
- **Test that would catch it:** Show `backup-operation` success tagged A; dismiss it; show a new persistent export success under that ID with a reveal action and no sandbox. Call `dismissSandboxToasts(A)` and assert the export result and action remain. Also replace an A-owned result with a B-owned result and assert only deleting B dismisses it.

## FE-LIB-HOOKS-2: Remote push toast ownership cannot be matched by deletion cleanup

- **Priority:** P3
- **File:line:** `app/SiloUI/src/lib/operation-toast.ts:63–79`.
- **Trigger:** Observe a remote repository push transition to failure or success, then delete that remote sandbox. The source rewrites remote push `workspace` to `remoteWorkspaceTarget(computer.id, workspace.machine.id)` (`desktop/production-source.ts:673–675`). Push toasts tag themselves with this qualified target (`features/application/components/use-repository-push-toasts.ts:51,59,66`). The library stores that string verbatim, but overview deletion cleanup calls `dismissSandboxToasts(known.name)` with the bare display name (`features/application/pages/overview-page.tsx:542–549`). Those keys differ even when the sandbox name is unique.
- **Consequence:** The persistent remote push result survives deletion. Failed results retain a Retry action targeting a deleted VM. Removing the operation from the push list does not close finished results: the push hook's removal cleanup dismisses only previously pushing states (`features/application/components/use-repository-push-toasts.ts:75`).
- **Suggested fix:** Give sandbox ownership one consistent identity contract across the toast API and deletion callers, using an immutable computer/VM identity. Keep the display name separate. Update all tags and deletion cleanup together; name-only keys also prevent independent cleanup of same-named sandboxes on different computers.
- **Test that would catch it:** Render a remote workspace and push it from pushing to failed so its Retry toast appears. Remove that workspace and its push operation from the source; assert the failed result disappears. Repeat with a successful persistent result and with a same-named sandbox on a second computer, whose notification must remain.
