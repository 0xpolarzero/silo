---
"silo-ui": patch
---

A sandbox action that is still waiting its turn now shows what it is waiting for ("Waiting for …") instead of prematurely reading "Starting…" or "Stopping…", switching to the action label once it actually runs. Cancelling an action you asked to cancel is shown as a neutral "Stop cancelled" state with a Retry, not a red error, and clicking Retry clears the previous message right away. Quit no longer stalls behind long-running work: it cancels anything still queued, tells you what it is waiting for, and offers "Cancel and quit" to stop cancellable running work (non-cancellable work such as an update install is still waited for).
