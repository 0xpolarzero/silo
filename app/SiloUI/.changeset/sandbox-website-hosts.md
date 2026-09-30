---
"silo-ui": minor
---

Websites published from a sandbox now open at an address of their own, such as `http://dev-1a2b3c4d.localhost:43000`, so cookies they set stay separate from other local services and sandboxes. Safari and unrecognized browsers keep using `127.0.0.1`, and each port has a **Copy 127.0.0.1 address** action for development servers that reject other host names.
