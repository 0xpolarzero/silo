---
"silo-ui": patch
---

Logs and sandbox activity now hide more kinds of secrets, such as `AWS_SECRET_ACCESS_KEY=`, `api_key =`, `Password:` lines and whole private key blocks, and strip more terminal control sequences from runtime output.
