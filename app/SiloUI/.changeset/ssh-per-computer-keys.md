---
"silo-ui": minor
---

SSH access to a sandbox on another computer now uses a key that belongs to the connecting computer; the owning computer's own key is never sent. Turning SSH access off revokes the keys other computers registered and replaces Silo's generated key, and removing a remote computer deletes this computer's SSH keys for it. Both computers need this version of Silo to connect over SSH.
