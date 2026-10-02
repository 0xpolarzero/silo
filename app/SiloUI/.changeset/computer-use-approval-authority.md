---
"silo-ui": patch
---

Computer use approval is now enforced by Silo rather than the sandbox's own disk: importing or transferring a sandbox always starts from Silo's default, and a failed approval change is retried instead of being shown as applied. The panel warns when agents in a sandbox can still act without asking until a change is applied.
