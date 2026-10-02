# Application frontend micro-review

Scope: `app/SiloUI/src/features/application/`. Read-only source review; no tests or builds executed. Checked the first, second, and third code-review reports for duplicates.

## FE-APPLICATION-1 — P2 — Navigation abandons operation notification trackers

- **Location:** `app/SiloUI/src/features/application/application-app.tsx:352`; `pages/overview-page.tsx:584`; `pages/overview-page.tsx:615`; `pages/workspaces-page.tsx:365`; `components/use-repository-push-toasts.ts:57`.
- **Trigger:** Start a sandbox, wait for its progress toast, select Files, and let Start finish. Conversely, start a repository push in Files, select All sandboxes, and let the push finish.
- **Evidence:** The application renders OverviewPage and WorkspacesPage as opposite branches of a conditional. Lifecycle tracking belongs to OverviewPage; its cleanup cancels timers but neither dismisses shown toasts nor retains tracking state. On remount, the tracking map is empty and initial failures are suppressed (`overview-page.tsx:511`). Push tracking belongs to WorkspacesPage; on remount its initial-success branch clears the backend operation without replacing/dismissing its old progress toast, and initial failures are skipped. Progress toasts have infinite duration (`lib/operation-toast.ts:167`).
- **Consequence:** Finished operations retain an indefinite Starting/Pushing toast. Returning to the original section does not repair it; failed operations also lose the tracker's Retry/result notification. The application's operation queue does not provide a replacement because lifecycle and push kinds have their own notifications.
- **Suggested fix:** Keep lifecycle and repository-push notification tracking mounted at application scope, independently of the visible workspace section. Preserve standalone page behavior if those pages are rendered outside ApplicationApp.
- **Regression test:** Through ApplicationApp, publish an in-flight lifecycle or push operation, navigate to the other workspace section, then publish success/failure while away. Assert that the existing progress toast is dismissed or replaced with the terminal result, and that failure Retry invokes the right sandbox/repository action. Navigate back and assert that no stale progress toast reappears.
