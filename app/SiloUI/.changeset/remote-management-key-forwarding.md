---
"silo-ui": minor
---

Remote management keys no longer carry owner forwarding privileges, and published ports on remote computers now go through guest SSH. This changes the remote protocol: a computer running this version cannot be managed by, or manage, a computer running an older Silo, so update Silo on both computers before reconnecting.
