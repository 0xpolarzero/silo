---
"silo-ui": patch
---

When connecting GitHub fails or is cancelled after you authorized Silo, Silo now revokes the new authorization instead of leaving it active on GitHub. Reconnecting also revokes the authorization it replaces: only the old token when you reconnect the same account, or the whole previous authorization when you switch to another account.
