---
"silo-ui": patch
---

Forking a sandbox and restoring a checkpoint now confirm with a toast, since both leave the result stopped and otherwise easy to miss. A completed fork shows "Fork created" with an Open action that jumps to the new stopped sandbox. A completed restore shows which checkpoint was restored, notes that a recovery checkpoint was saved first, and offers Start, which runs the same guarded start as the sandbox page (respecting capacity and unavailable-operation notices). Checkpoint creation stays silent, since the new row is feedback enough, and errors continue to appear inline.
