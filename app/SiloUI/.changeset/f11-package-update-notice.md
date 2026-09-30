---
"silo-ui": patch
---

On Linux, opening Silo while its package update is still running, or after an update was interrupted, now shows a dialog instead of doing nothing. An interrupted update names the command that finishes it (`sudo dpkg --configure -a`).
