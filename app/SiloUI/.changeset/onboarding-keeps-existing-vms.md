---
"silo-ui": patch
---

Setup no longer deletes existing VMs when it starts before their configuration has loaded; it stops with an explanation and leaves every VM unchanged. Cancelling Quit (for example when a VM would not stop) no longer leaves setup and sandbox create, edit, or delete refusing with "Silo is quitting" until relaunch.
