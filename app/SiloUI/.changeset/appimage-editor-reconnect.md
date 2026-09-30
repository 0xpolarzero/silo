---
"silo-ui": patch
---

When Silo runs as an AppImage, Visual Studio Code and Zed can reconnect to a sandbox after Silo restarts: their SSH settings now point at the AppImage file instead of its temporary mount, and settings written by earlier versions are updated at startup.
