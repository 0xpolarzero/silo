---
"silo-ui": patch
---

Importing a sandbox no longer fails with "malformed VM data" on computers with many sandboxes. If the runtime's list is too large to check safely, the import stops with a clear size-limit message.
