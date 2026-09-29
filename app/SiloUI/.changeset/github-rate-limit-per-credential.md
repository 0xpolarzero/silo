---
"silo-ui": patch
---

A GitHub rate limit now only delays requests made with the credential that reached it. A limit on the GitHub OAuth connection no longer makes the personal-token check fail and detach sandboxes that use a personal token, and a personal-token limit no longer delays OAuth access.
