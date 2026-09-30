---
"silo-ui": patch
---

Stopping or restarting a running sandbox now asks first everywhere in the main window, as the menu bar already did: the Stop button in the Sandboxes list and on the sandbox page, Restart… in the ⋯ menu, and Stop/Restart in the command palette show "Stop dev? Running processes will be interrupted." with a destructive confirm button. Starting and opening never ask, and menu labels end with "…" only when a question follows (for example Delete…).
