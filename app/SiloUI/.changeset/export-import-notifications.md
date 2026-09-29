---
"silo-ui": minor
---

Export and import now run as background notifications instead of inline panels. Starting an export from a sandbox, its detail page, or a checkpoint opens the folder picker and then reports progress, and completion, as a toast that survives navigation. A finished export offers Show in Finder (macOS) or Show in folder (Linux) to locate the `.silo-backup` file; Silo only reveals exports it created and still tracks. Importing opens a dialog to validate the export, pick a sandbox when several are present, and name the new one, after which progress continues in a toast with Open to jump to the imported sandbox. Failures stay until dismissed and offer Retry; cancelling an import confirms first, since it removes the incomplete sandbox.
