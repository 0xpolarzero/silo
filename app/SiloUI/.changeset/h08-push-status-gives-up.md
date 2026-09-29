---
"silo-ui": patch
---

A push whose status Silo cannot confirm no longer shows as pushing forever. Silo checks less often while the host does not answer, then shows the push as unknown with a reminder to check the branch on GitHub; acknowledging it re-enables Push. A push on a deleted sandbox or removed computer stops being checked.
