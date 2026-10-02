---
"silo-ui": patch
---

Bound reads of the remembered export-folder file to 1 MiB. Oversized advisory files are preserved and ignored without touching backups or unfinished-operation recovery.
