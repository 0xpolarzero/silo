---
"silo-ui": patch
---

Imports now check an export file's snapshot before handing it to the runtime. Files with links, special entries, unsafe paths, too many entries, or more unpacked data than the runtime storage can hold are refused before anything is written to the runtime.
