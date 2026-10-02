# Sandbox frontend micro-review

Scope: `app/SiloUI/src/features/sandboxes/`.

Read-only source review. Prior first-pass, second-pass, and available third-pass reports were checked for these files and behaviors; neither finding was already reported. No builds, tests, application launches, or source changes were performed.

## FE-SANDBOXES-1: Opening Add discards unsaved edits

- **Priority:** P2.
- **File:line:** `app/SiloUI/src/features/sandboxes/components/machine-list.tsx:253`; `app/SiloUI/src/features/sandboxes/model/use-machine-editing.ts:120`.
- **Trigger:** Edit a sandbox field, click Add, then dismiss the menu without selecting an option.
- **Evidence:** The Add trigger calls `beginOperation`, which immediately calls `setEditor(null)`. This unmounts the editor; the draft persistence effect at `use-machine-editing.ts:88–92` also deletes the cached draft. Menu dismissal only changes `addOpen`, so it cannot restore the edit. No save or explicit Cancel/Discard occurs.
- **Consequence:** Merely inspecting the Add menu loses unsaved configuration edits, including the draft otherwise preserved across navigation.
- **Suggested fix:** Remove `beginOperation` from the menu trigger. Resolve replacement of an existing draft when the user actually selects an operation, preserving it or explicitly obtaining a discard decision.
- **Test that would catch it:** Open an editor, change CPUs, open Add, press Escape, and assert the editor and changed CPUs remain. Leave and return through `MachineEditorDraftsProvider` and assert the same draft is restored and no save was submitted.

## FE-SANDBOXES-2: Save settlement after unmount leaves a completed draft cached

- **Priority:** P2.
- **File:line:** `app/SiloUI/src/features/sandboxes/model/use-machine-editing.ts:193`; related cache effect at line 88 and restoration at lines 69–74.
- **Trigger:** Start an asynchronous `onCommitMachine` save, navigate away so the editor surface unmounts, let the save succeed, then return.
- **Evidence:** Draft cache updates and deletion occur only in the mounted hook's effect. After awaiting the commit, success calls `setEditor(null)`, which updates component state but never directly deletes the provider's map entry. Once that hook is unmounted, its effect cannot run. A new hook reads the surviving entry in its state initializers. This is reachable in the application: `overview-page.tsx:700–709` switches between a keyed detail page and `MachineList`, while `application-app.tsx:319–410` keeps their draft provider mounted.
- **Consequence:** Returning resurrects an already-saved edit with its old baseline. The UI presents completed work as unsaved; submitting it again can produce a stale-baseline rejection. The remounted editor also initializes `committing` to false if the original save is still pending. The existing saving and draft-navigation tests cover these cases separately, but do not combine them.
- **Suggested fix:** Track pending save ownership with the cached draft and settle that cache directly, independently of component effects. Clear only the draft associated with the completed save, so an older completion cannot erase a newer edit. Restore pending status when remounting before settlement.
- **Test that would catch it:** Keep the provider mounted, start a save backed by a deferred promise, unmount the surface, resolve the promise, publish the saved configuration, and remount. Assert no editor is restored. Also remount before resolution and assert the same save remains pending and cannot be submitted twice.
