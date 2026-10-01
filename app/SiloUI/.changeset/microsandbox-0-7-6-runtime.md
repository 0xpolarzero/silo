---
"silo-ui": patch
---

Update the bundled MicroSandbox runtime to 0.7.6. Commands that run inside a sandbox (identity checks, tool verification, repository and account setup) no longer wait on an open input pipe, which could leave an operation hanging. Checkpoint exports made with the previous runtime still import.
