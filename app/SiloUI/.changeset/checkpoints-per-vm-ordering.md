---
"silo-ui": patch
---

Checkpoint create and restore now wait only for other work on the same VM instead of blocking every VM, so a checkpoint on one sandbox no longer holds up actions on others. Per-VM ordering also keys on a sandbox's stable identity, so renaming a sandbox can no longer let two operations on it run at once.
