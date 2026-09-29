---
"silo-ui": patch
---

After a fork or Restore Start creates its VM, Silo now reads that sandbox from the runtime instead of failing to load every sandbox when the start could not be verified. A fork or restored sandbox that started successfully is also recognized by the Storage panel and automatic space reclamation, instead of asking you to restart it.
