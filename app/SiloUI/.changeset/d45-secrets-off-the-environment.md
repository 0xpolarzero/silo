---
"silo-ui": patch
---

Sandbox secrets and GitHub access credentials no longer pass through the bundled runtime's environment, where other programs running as you could read them and where a secret named like a system setting could change the runtime's behaviour. Silo now hands them to the runtime privately when it starts, updates or restores a sandbox. Secret-name rules are now defined once and shared by the secret form and the app.
