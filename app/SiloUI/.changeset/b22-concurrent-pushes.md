---
"silo-ui": patch
---

Pushing one repository no longer makes pushes of other repositories fail with "Another host push is using the publishing cache". Only a second push of the same repository waits for the first to finish, and a cache still in use is never evicted to make room.
