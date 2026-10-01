---
"silo-ui": patch
---

While the sandbox storage upgrade is waiting, running or failed, Silo no longer touches your previous sandbox storage. Before, launching the new version could change that folder's database so that the older Silo could not open it again, and could interfere with the copy the upgrade was making. That folder now stays exactly as it was until the upgrade completes, and after you choose to continue without unmigrated sandboxes. Quitting and installing an update still work while a migration needs attention.
