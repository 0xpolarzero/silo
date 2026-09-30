---
"silo-ui": patch
---

Deleting a sandbox now removes its GitHub repository access and revokes the GitHub tokens issued to it. A new sandbox created with the same name starts without any GitHub access instead of inheriting the deleted sandbox's repositories and write permission.
