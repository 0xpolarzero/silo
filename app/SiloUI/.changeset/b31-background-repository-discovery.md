---
"silo-ui": patch
---

Finding repositories in a sandbox no longer slows down or stalls Silo's status updates. Silo reads each sandbox's repositories in the background, one read at a time, shows the last known list meanwhile, and skips dependency folders such as `node_modules` and `.venv`. Refresh repositories still waits for an up-to-date list.
