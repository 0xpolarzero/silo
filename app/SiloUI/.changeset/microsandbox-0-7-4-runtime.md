---
"silo-ui": patch
---

Upgrade the bundled VM runtime to MicroSandbox 0.7.4. Requests that use a secret placeholder in a header are no longer blocked when the request body contains percent or unicode escapes, and shared-folder files that keep a second hard link stay writable on macOS. Exports made by a Silo version that bundled MicroSandbox 0.7.2 are not accepted by this version: import them with the Silo version that created them, then export them again.
