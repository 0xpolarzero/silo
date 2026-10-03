---
"silo-ui": patch
---

Prevent an older Start, Stop, or Restart retry from undoing a newer lifecycle action on the same sandbox. Local and remote actions share this ordering; actions on other sandboxes still run independently.
