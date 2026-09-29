---
"silo-ui": patch
---

Silo no longer keeps checking other computers over SSH while its windows are closed or hidden; it refreshes as soon as a window becomes visible again. Visible windows check each remote computer once per interval instead of twice, and bursts of VM state changes trigger one refresh instead of one per change.
