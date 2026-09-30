---
"silo-ui": patch
---

If Silo refuses a settings change as invalid, the change is now undone and reported instead of being retried forever. Later settings changes save normally, and Quit is no longer blocked by the refused change.
