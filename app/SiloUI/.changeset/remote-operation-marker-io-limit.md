---
"silo-ui": patch
---

Bound reads of remote-operation journal records to 16 MiB. Oversized records keep the operation marked as uncertain and prevent it from being replayed after restart.
