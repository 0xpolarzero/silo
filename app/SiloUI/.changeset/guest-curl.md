---
"silo-ui": patch
---

Include curl in newly created VMs. Existing VMs keep their installed packages; run `apt-get update && apt-get install -y curl` inside an existing VM if needed.
