---
"silo-ui": patch
---

SSH access status no longer freezes while an SSH listener starts, and Silo's background SSH check runs every 15 seconds instead of every 2 seconds, only when SSH access is turned on for a sandbox, so it no longer delays other sandbox actions.
