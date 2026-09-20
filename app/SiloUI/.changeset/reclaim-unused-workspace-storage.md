---
"silo-ui": minor
---

Automatically reclaim unused local workspace disk space after seven days and before stopping when the last reclaim was at least a day ago, with bounded attempts that do not prevent shutdown. Add a Storage panel showing host disk allocation, workspace usage, manual reclamation, and a collapsed history of the latest 50 attempts, with measurement tooltips and reclaim progress. Fix a runtime bug that shortened disk images when reclaiming their unused tail.
