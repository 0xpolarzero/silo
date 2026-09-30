---
"silo-ui": patch
---

Quitting Silo from the Dock or with an AppleScript `quit` now goes through the same Quit as the Silo menu, so settings are saved and local sandboxes stop. Logging out, restarting or shutting down (macOS and Linux) and a SIGTERM now stop local sandboxes gracefully without asking, within the time the system allows.
