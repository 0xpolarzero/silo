---
"silo-ui": patch
---

GitHub access updates now wait their turn behind other work on the same sandbox and show as "Applying GitHub access" in the operation queue, so a token refresh can no longer collide with an edit, checkpoint restore or removal. Starting a sandbox no longer waits indefinitely behind an access update, and a newer access choice replaces an older one that is still waiting.
