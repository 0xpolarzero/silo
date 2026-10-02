---
"silo-ui": patch
---

Avoid reporting successful workspace reclamation as a failure when concurrent guest writes grow a checkpoint's writable qcow2 disk file.
