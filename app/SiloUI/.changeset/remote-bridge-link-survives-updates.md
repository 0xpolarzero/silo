---
"silo-ui": patch
---

Other computers can keep managing this one after Silo restarts, updates or runs from an AppImage: Silo re-points its remote bridge at the AppImage file (not its temporary mount) on every launch. On macOS, Silo asks to be moved to Applications instead of linking a temporary copy.
