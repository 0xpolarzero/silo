---
"silo-ui": patch
---

Record the new import's checkpoint group before loading it, so relaunch recovery can remove unfinished native checkpoints even when no sandbox settings were saved.
