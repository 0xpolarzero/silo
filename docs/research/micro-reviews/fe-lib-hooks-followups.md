# Frontend library and hooks fix-loop findings

Scope: `app/SiloUI/src/lib/` and `app/SiloUI/src/hooks/`. Follow-up to the untracked micro-review in the shared review worktree.

## FE-LIB-HOOKS-3: Retry dismisses the replacement progress toast

- Priority: P2.
- File: `app/SiloUI/src/lib/operation-toast.ts`, `showOperationFailure` Retry action.
- Trigger: Click Retry when its handler synchronously starts progress under the same toast ID. Production examples include port mutations (`features/application/components/network-ports-state.ts`, `run`) and checkpoint operations (`features/application/model/checkpoint-operation-toast.ts`, `runCheckpointOperation`).
- Consequence: Sonner dismisses the toast after the action handler returns, removing the new operation's progress and Cancel control while the operation remains running. A rendered regression failed after advancing past the exit animation.
- Fix: Use Sonner's supported `event.preventDefault()` for operation retries, preserving the toast until the retry reports its next state. Forward the action event through the shared wrapper, and keep sandbox ownership for actions that prevent automatic dismissal.
- Test: Click an actual Retry that starts same-ID progress; advance past the exit animation; assert progress remains and Cancel invokes its handler. Also check that a retry awaiting backend state retains deletion cleanup.
- Primary source: [Sonner v2.0.8 action handling](https://github.com/emilkowalski/sonner/blob/v2.0.8/src/index.tsx). Its action button invokes the callback, checks `event.defaultPrevented`, and otherwise calls `deleteToast`. The installed v2.0.8 `dist/index.mjs` has the same action behavior. This uses an existing upstream feature and requires no custom notification subsystem.


## FE-LIB-HOOKS-4: Tab entry into a hover preview loses focus

- Priority: P3.
- File: `app/SiloUI/src/hooks/use-sidebar-disclosure.ts`, preview keyboard listener and `scheduleClose`.
- Trigger: Hover the collapsed-sidebar toggle until the preview opens; focus the toggle; leave it with the pointer and press Tab into the sidebar. The Tab event starts outside the navigation element, so the sidebar's `onKeyDown` does not set keyboard navigation mode.
- Consequence: After the 160 ms close delay, the preview collapses despite keyboard focus inside it and restores focus to the toggle. The rendered sidebar regression observes `data-previewing=false` instead of the expected retained preview.
- Fix: Track Tab in the preview's existing window keydown listener, including events that originate on the toggle.
- Test: Enter the real preview from its toggle with Tab, advance beyond the close delay, and assert the preview and focused navigation control remain. Then move focus to page content and verify dismissal still works.
