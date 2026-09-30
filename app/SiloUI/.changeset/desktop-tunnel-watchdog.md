---
"silo-ui": patch
---

If Silo crashes or is force-quit while a sandbox desktop is open, the desktop's background connection now ends too instead of running on and holding the sandbox's connection. A connection whose sandbox stops answering also closes after about 45 seconds so the viewer can reconnect.
