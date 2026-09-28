---
"silo-ui": patch
---

Initial setup and retries no longer overwrite sandbox changes made meanwhile. Setup applies its sandboxes as one atomic batch of targeted changes, and retrying a failed setup resumes the recorded attempt against the current settings instead of resending a whole list, so concurrent edits are preserved.
