---
"silo-ui": patch
---

Remove secrets immediately from the list and credential store even when a sandbox is unreachable. Retry revocation in the background and warn on affected sandboxes with a Restart action, including remote sandboxes. Keep replacement secrets safe when a removed name is added again.
