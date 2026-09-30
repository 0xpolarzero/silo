---
"silo-ui": patch
---

Sandboxes converted to the checkpoint runtime could no longer start once the previous runtime folder was deleted, failing with a missing image file. Silo now points their image files at the converted runtime when it starts, and new conversions no longer depend on the previous folder.
