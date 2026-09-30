---
"silo-ui": patch
---

While Silo works on one sandbox (starting it, creating or restoring a checkpoint), that sandbox keeps showing its last known state next to its progress label, and every other sandbox keeps refreshing; sandboxes starting at launch no longer delay the first list. A sandbox whose state cannot be read shows its last known status with a warning instead of the whole list failing to load.
