---
"silo-ui": patch
---

Silo now connects to another computer with its own SSH key alone first, so an SSH agent holding many keys (1Password, Secretive) no longer exhausts the other computer's login attempts before Silo's key is tried. If only your own keys work there, Silo falls back to them and remembers that choice.
