---
"silo-ui": patch
---

A momentary failure to read export or import progress no longer turns a running export or import into a fake "failed" result; Silo keeps showing its progress and reports the read problem if you try to start another one.
