---
"silo-ui": patch
---

Checking whether Git identities are already set up no longer boots stopped sandboxes, and saving or checking Git identities now works on one sandbox at a time with a named, cancellable entry in the queue instead of holding up every other sandbox.
