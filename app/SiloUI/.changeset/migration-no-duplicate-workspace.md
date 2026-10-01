---
"silo-ui": patch
---

Upgrading sandboxes to the checkpoint runtime no longer leaves an unused copy of each workspace disk in Silo's storage. On Linux that copy could take as much space as the workspace itself, and the upgrade now needs less free space while it runs.
