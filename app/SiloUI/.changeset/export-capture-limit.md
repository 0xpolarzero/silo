---
"silo-ui": patch
---

State exports stop creating hidden snapshots after 128 captures per sandbox. Exporting an existing checkpoint remains available; existing captures are preserved because later checkpoints depend on them.
