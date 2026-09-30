---
"silo-ui": patch
---

Exports and imports spend less time reading disks: an export reads each captured snapshot once less, and importing one sandbox from a multi-sandbox export unpacks only that sandbox.
