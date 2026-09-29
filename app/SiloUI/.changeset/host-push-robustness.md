---
"silo-ui": patch
---

Host push is more robust: stray files such as .DS_Store in the push cache no longer break every push, a damaged push history no longer hides the rest of the app state, a crashed push no longer stays "pushing" forever, retries after a remote rejection reuse the already-imported cache, and on Linux pushes trust the system certificate store when it is present.
