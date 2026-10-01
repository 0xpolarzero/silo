---
"silo-ui": patch
---

An export or import that was interrupted just before an upgrade no longer holds back the sandbox storage upgrade. Silo settles it without writing anything to your previous sandbox storage, which stays exactly as it was, keeps a finished export file, and tells you when you need to run it again.
