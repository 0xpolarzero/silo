---
"silo-ui": minor
---

Queued operations can now be cancelled, and some running operations (starting or restarting a VM, capturing a checkpoint, backing up, setting up guest tools or the desktop, and applying GitHub access or secrets) can be cancelled while they run. Operations that run longer than expected are flagged as "Taking longer than expected", and safe actions like starting, stopping, or restarting a VM retry automatically after a temporary failure. Failed lifecycle actions offer a Retry that re-runs the same intent against fresh state.
