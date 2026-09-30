---
"silo-ui": patch
---

Retrying Start after a restored or forked sandbox ran but could not be verified now keeps that sandbox and starts it, instead of recreating it from the checkpoint and silently discarding changes made to its workspace.
