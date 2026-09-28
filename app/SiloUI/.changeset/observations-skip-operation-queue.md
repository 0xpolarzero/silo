---
"silo-ui": patch
---

Status, SSH access, and port views stay responsive while a long operation such as a backup is running: reading them no longer waits its turn behind VM-changing work, and opening a remote SSH connection or browsing files is never queued. Port forwarding and SSH listener repairs still take their turn in order, so changes remain safely serialized.
