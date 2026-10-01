---
"silo-ui": patch
---

After an upgrade, Silo now tells you what became of an export or import that was interrupted before it, and when an export or import record it could not read was set aside. The result appears on the "Your sandboxes were updated" screen, and Open Silo marks it as seen; when that screen does not appear, it shows as an ordinary export and import notification that stays until you dismiss it. Outside an upgrade, an export or import record that Silo can't read no longer keeps exports and imports unavailable until you remove the file by hand: Silo renames it aside in its data folder, never deletes it, and tells you to run the export or import again if one was running.
