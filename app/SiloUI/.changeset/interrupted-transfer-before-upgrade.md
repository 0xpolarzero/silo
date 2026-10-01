---
"silo-ui": patch
---

An export or import that was interrupted just before an upgrade no longer holds back the sandbox storage upgrade. Silo reports it as interrupted before the upgrade, so you can run it again, and keeps a finished export file. Settling it no longer writes anything to your previous sandbox storage, which stays exactly as it was.
