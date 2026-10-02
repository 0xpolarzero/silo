---
"silo-ui": patch
---

Reject oversized saved sandbox configuration before reading the entire file into memory, keeping the existing 1 MiB limit and preserving the saved file.
