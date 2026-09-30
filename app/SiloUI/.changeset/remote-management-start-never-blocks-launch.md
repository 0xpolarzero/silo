---
"silo-ui": patch
---

Silo now opens even when remote management cannot start, for example when another Silo process owns it, its settings are damaged, or a different file is at `~/.local/bin/silo-remote`. Settings → Computers shows the reason, and turning remote management on again retries.
