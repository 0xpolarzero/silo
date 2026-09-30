---
"silo-ui": minor
---

Checkpoints can now be deleted from a sandbox's Checkpoints tab, after a confirmation. Each checkpoint shows its size, and one that a fork, a later checkpoint or the sandbox itself still builds on shows what uses it and why it can't be deleted yet. Deleting a sandbox now also removes the checkpoint data only it used, a failed checkpoint no longer leaves its data behind, and Silo clears checkpoint data no sandbox uses any more. The Storage tab shows how much space checkpoints take.
