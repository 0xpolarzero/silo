---
"silo-ui": patch
---

Let queued steps finish a remote request once another worker has already started it, even if its original start deadline expires.
