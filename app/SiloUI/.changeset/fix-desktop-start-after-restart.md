---
"silo-ui": patch
---

The Linux desktop now starts reliably after a sandbox restarts or is imported: a leftover audio-server file from the previous session no longer stops it, a failed session start is retried, and computer use waits for the desktop instead of reporting that it was not running.
