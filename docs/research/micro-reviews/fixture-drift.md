# Frontend fixture drift

## Directory listings

The preview directory loader returned empty success for missing paths, listed
stopped sandboxes, resolved remote requests by a bare name, and paged mutable
arrays under a constant snapshot ID. The native
[directory command](../../../app/SiloUI/src-tauri/src/files.rs) validates paths
and 200-entry offsets, checks running VM state, sorts folders before files,
and binds pagination to an owner/path snapshot for two minutes. The
[guest helper](../../../app/SiloUI/src-tauri/guest/list-directory.py) reports
missing and non-folder paths separately.

Fixture regressions failed before the correction and now exercise those native
states and errors. The real native stopped-state string, `Start this VM to browse
its files.`, also exposed a frontend allowlist mismatch. The directory store now
translates that known error to the existing sandbox terminology instead of
hiding it behind a generic failure. Checks use deterministic fixtures only;
no installed app or live VM is covered.
