---
"silo-ui": patch
---

Setup now starts from the sandboxes that already exist on this computer once they load, instead of the default sandbox, and it never deletes an existing sandbox you did not delete yourself: if setup no longer lists one, it asks whether to keep or delete it first. Retrying a failed setup step now uses your current choices (for example edited Git identities or repositories) instead of repeating the failed request.
