---
"silo-ui": patch
---

Deleting a fork or restored sandbox whose checkpoint start could not be verified now also removes the VM that start created (stopping it first if needed), instead of leaving it behind in the runtime. A damaged checkpoint history no longer blocks deleting its sandbox.
