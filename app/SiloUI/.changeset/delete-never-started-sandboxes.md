---
"silo-ui": patch
---

Sandboxes that were never started can be deleted again. Deleting one used to fail, so a setup that stopped before the sandbox's first start, or an import that was interrupted, could leave a sandbox behind that kept its name. The bundled runtime now removes such a sandbox together with its disk, and an interrupted import no longer asks you to pick another name.
