---
"silo-ui": patch
---

On Debian and Ubuntu, updating Silo from the app now authenticates, checks Silo's software source, refreshes the package list and downloads the update before stopping any sandbox. Cancelling authentication, a disabled source, a busy package manager or a release that is not yet available no longer stops and restarts your sandboxes, and an update that waits too long gives up after 30 minutes without stopping them.
