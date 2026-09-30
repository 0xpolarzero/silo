---
"silo-ui": patch
---

After an in-app update on Debian and Ubuntu, Silo now closes its SSH tunnels and listeners before restarting so the new version can reuse their ports. If Silo is updated but cannot restart itself, it resumes the sandboxes it stopped and asks you to quit and reopen Silo instead of offering to install the update again.
