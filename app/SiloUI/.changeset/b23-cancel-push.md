---
"silo-ui": patch
---

A running push can now be cancelled from its notification, and quitting Silo can cancel it instead of waiting. Silo stops the Git transfer, cleans up the sandbox export, and reports "Push cancelled"; if GitHub was already receiving the push, the result asks you to check the branch on GitHub. Pushes also renew Silo's GitHub sign-in when it would expire soon and stop cleanly, rather than failing midway, if they outlast their GitHub credential.
