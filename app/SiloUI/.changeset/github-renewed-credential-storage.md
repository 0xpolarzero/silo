---
"silo-ui": patch
---

When the system credential store cannot save a renewed GitHub credential, Silo keeps using the renewed credential and retries saving it instead of failing every GitHub request.
