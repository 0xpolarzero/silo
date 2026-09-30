---
"silo-ui": patch
---

Remove unused checkpoint data when a sandbox or its last fork is deleted. Recover interrupted checkpoint cleanup from operation journals at launch instead of deleting old snapshots by age.
