---
"silo-ui": patch
---

Saving a sandbox change that turns out to change nothing no longer leaves the list stuck on "Applying sandbox changes". A save rejected because the sandbox changed meanwhile now shows the latest reported state instead of an older one, and a push in progress stays visible while sandbox changes are reported.
