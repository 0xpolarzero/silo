---
"silo-ui": patch
---

Use standard Git and Git LFS transfers for explicit pushes, including empty files and historical LFS data. Reuse a bounded publishing cache without giving sandboxes GitHub write access. Keep push progress and results across remote disconnections, prevent duplicate requests, and identify unknown outcomes after a host restart. Update Silo on both computers to use the new remote push flow.
