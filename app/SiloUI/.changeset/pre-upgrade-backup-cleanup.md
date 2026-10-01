---
"silo-ui": minor
---

After an upgrade converts your sandboxes to the new storage, Silo keeps the previous storage as a pre-upgrade backup, tells you its size and the date it will delete it (14 days later), and deletes it automatically. On Linux the backup can be as large as all your sandboxes, so you can free that space sooner: Settings, General, Storage has Show and Delete now. Silo only deletes it after every sandbox was converted, never after you continued past a failed migration.
