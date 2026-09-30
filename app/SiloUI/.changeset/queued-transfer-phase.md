---
"silo-ui": patch
---

An export or import that waits for other sandbox work now shows "Waiting for other sandbox work" instead of claiming it is already creating snapshots. A checkpoint export keeps its "Exporting checkpoint" title after Silo reloads, and trying to start another export while one runs no longer renames the running export or changes its Retry.
