---
"silo-ui": patch
---

Refreshing sandbox state does less work: expired logs of stopped sandboxes are cleaned in the background at most once an hour instead of on every refresh, and two windows refreshing at once no longer scan the same sandbox for repositories twice.
