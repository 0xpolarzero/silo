---
"silo-ui": patch
---

Reject remote-management settings larger than 1 MiB without replacing the saved settings, preventing oversized files from exhausting memory during remote status reads.
