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


## FE-LIB-HOOKS-5: Soft hyphens bypass guest-name visibility markers

- Priority: P2.
- File: `app/SiloUI/src/lib/visible-text.ts:13`.
- Trigger: A guest provides a file or folder name such as `con\u00ADfig` beside an ordinary `config`. The visibility helper leaves U+00AD unchanged; the file tree uses that output for its displayed name and accessible folder label.
- Consequence: A distinct guest-controlled path can look like the ordinary path because soft hyphens have no width unless a line breaks there. The unit and rendered-file-tree regressions both failed to find the expected visible marker before the fix.
- Fix: Include U+00AD in the existing invisible-character regex.
- Test: Assert `con\u00ADfig.json` displays a U+00AD marker. Render a folder with that character, find it by its marked label, and verify Open passes the original path unchanged.
- Primary source: [Unicode UAX #14, Soft Hyphen](https://www.unicode.org/reports/tr14/tr14-51.html#SoftHyphen), which defines its invisible, zero-width rendering between line breaks. This is a targeted correction to the existing display policy, not a claim to prevent all Unicode lookalike names.


## FE-LIB-HOOKS-6: Progress retains a finished result's action

- Priority: P2.
- File: `app/SiloUI/src/lib/operation-toast.ts`, `showOperationProgress`.
- Trigger: Show an actionable success or retryable failure, then show progress under the same ID. Progress options omit `action`, so Sonner merges in the previous result's action. The rendered regressions found both stale Retry and Open controls beside the new progress.
- Consequence: The progress toast offers actions belonging to an earlier result. A retained Retry can start the same operation again while its first retry is still running; retained Open refers to the previous completed result.
- Fix: Explicitly clear `action` when rendering progress.
- Test: Replace both a Retry failure and an Open success with same-ID progress; assert their old actions are absent and the new Cancel control remains.
- Primary source: [Sonner v2.0.8 state updates](https://github.com/emilkowalski/sonner/blob/v2.0.8/src/state.ts), whose existing-ID update spreads previous toast properties before supplied data. Supplying an undefined action removes the previous action through the supported toast options.
