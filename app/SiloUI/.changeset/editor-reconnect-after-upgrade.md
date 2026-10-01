---
"silo-ui": patch
---

Editors that reconnect on their own after an upgrade now open your current sandbox instead of the copy kept from before the upgrade. Before, an editor window restored by VS Code or Zed kept using the old storage until you opened the sandbox from Silo again: it could start the stale copy, and it stopped connecting once that backup was deleted. Silo now points those editor connections at the upgraded storage at launch, adding one line to your SSH configuration when needed. Your existing lines stay, and the pre-upgrade backup is not touched.
