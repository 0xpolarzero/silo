---
"silo-ui": patch
---

Following logs now reads only the records written since the last refresh instead of rescanning every retained log file every three seconds, and no longer inspects the sandbox or cleans up expired logs on each refresh. Silo also keeps fewer log search snapshots in memory.
