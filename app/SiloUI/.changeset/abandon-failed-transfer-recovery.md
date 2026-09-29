---
"silo-ui": patch
---

An export or import that could not be resumed after relaunch no longer blocks sandbox startup recovery on every launch. Dismissing its failure stops retrying and keeps any files it left, which also unblocks app updates. Cancelling an export or import now works even when Silo cannot save its progress.
