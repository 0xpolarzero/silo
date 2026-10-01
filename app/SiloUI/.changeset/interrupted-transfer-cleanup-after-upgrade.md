---
"silo-ui": patch
---

What an export or import that was interrupted just before an upgrade left behind is now removed from your upgraded sandbox storage once the upgrade is done, instead of staying there with everything else that was copied. The previous storage, kept as the pre-upgrade backup, is not changed. An export or import record that Silo can't read no longer holds back the upgrade: Silo sets the file aside in its data folder, never deletes it, and tells you to run the export or import again if one was running.
