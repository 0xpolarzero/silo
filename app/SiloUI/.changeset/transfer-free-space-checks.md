---
"silo-ui": patch
---

Exports and imports now check free space before copying data. An export stops before writing the file when the destination is too full, and an import stops before unpacking when Silo's working or runtime storage is too full. Both messages say how much space is needed and how much is available.
