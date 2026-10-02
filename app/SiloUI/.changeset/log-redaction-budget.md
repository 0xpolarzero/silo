---
"silo-ui": patch
---

Count unfinished private-key redaction state against the log search memory budget, so searches over many such records fail with a narrow-your-search message instead of using unbounded memory.
