---
"silo-ui": patch
---

Push now uses a GitHub token that can only write commits to the one repository being pushed, and Silo revokes it as soon as the push ends. The token reaches Git through a private pipe instead of process settings that other programs could read.
