---
"silo-ui": patch
---

Forking a running sandbox's current state no longer makes every other sandbox wait while its memory is saved; only the source sandbox is busy until the fork is added. A fork that fails partway now removes everything it added and reports the original error.
