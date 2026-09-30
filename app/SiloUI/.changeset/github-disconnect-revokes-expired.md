---
"silo-ui": patch
---

Disconnecting GitHub after the sign-in token expired now renews it first and then revokes Silo's authorization on GitHub, instead of treating GitHub's answer for the expired token as success and leaving the authorization active.
