---
"silo-ui": patch
---

Editing a sandbox that changed elsewhere now warns instead of overwriting. Silo remembers the sandbox's configuration from the moment you opened the editor (or started a delete or drag) and saves against that baseline, so a queued edit can no longer silently overwrite a concurrent change. If the sandbox changed while your edit was waiting, the editor stays open with your edits and offers to review the latest values or discard your changes; if it changed or was deleted while the editor was open, an inline notice tells you before you save.
