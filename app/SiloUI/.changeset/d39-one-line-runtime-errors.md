---
"silo-ui": patch
---

Sandbox start, stop, restart and setup failures now show one line that says what happened and what to do, without exit codes or raw runtime output; the runtime's own explanation is kept separately for a details view. A configuration change that fails after some sandboxes were already changed now keeps its precise reason and says that the completed changes were kept.

Older activity failures also keep process details behind the diagnostic field, and runtime launch failures explain how to retry.
