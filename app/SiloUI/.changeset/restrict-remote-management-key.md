---
"silo-ui": patch
---

Silo's remote-management SSH key can now only run Silo's connection bridge and open tunnels to ports on the other computer's loopback address; it no longer grants a shell. Computers set up with an earlier version are tightened automatically the next time Silo connects to them.
