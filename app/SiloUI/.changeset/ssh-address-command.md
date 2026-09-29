---
"silo-ui": patch
---

The SSH panel now shows and copies a working command such as `ssh -p 2222 silo@192.168.1.42` with the sandbox's real login account instead of an invalid `root@host:port` address. Sandboxes on another computer no longer show that computer's local-only `127.0.0.1` address.
