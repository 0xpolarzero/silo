---
"silo-ui": patch
---

Removing a secret no longer gets stuck when an assigned sandbox was deleted, is missing from the runtime, or is stopped but could not confirm the change: such a sandbox cannot use the secret, so the removal finishes. A running sandbox still has to confirm before the secret is deleted.
