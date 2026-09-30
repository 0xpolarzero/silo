---
"silo-ui": patch
---

Sandbox GitHub access now requests only the permissions it needs. Read-only access covers contents, issues, pull requests, statuses and checks. "Allow GitHub changes" adds write access to contents, issues, pull requests and statuses, plus workflow changes and read access to Actions runs. Sandboxes no longer receive administration, secrets, webhooks, environments or security-alert access, even when the GitHub App was granted them.
