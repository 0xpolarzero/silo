---
"silo-ui": patch
---

Block updates while an unfinished sandbox setup still owns a runtime VM, so installation cannot leave that VM running unnoticed.
