---
"silo-ui": patch
---

Silo no longer freezes when the last export folder is on a stalled network share or a sleeping disk: refreshing export and import status no longer measures that folder, and cancelling or dismissing an export or import no longer writes to disk on the window's main thread.
