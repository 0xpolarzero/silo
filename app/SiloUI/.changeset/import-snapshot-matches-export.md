---
"silo-ui": patch
---

Imports now confirm that the snapshot inside an export file matches the settings the file declares. A file whose snapshot adds mounted volumes, a different image, a default user or other undeclared settings is refused, and the data it loaded is removed.
