---
"silo-ui": patch
---

Quitting during setup no longer waits up to five minutes for GitHub to confirm sandbox access; that check stops and can be repeated after reopening Silo. While Quit waits for setup work that is already running, the overlay names it (for example "Finishing setup (creating sandboxes)…") instead of "Stopping local sandboxes…".
