---
"silo-ui": patch
---

When a sandbox boots but Silo cannot confirm its state or record which secrets it started with, Silo now stops it again and reports the start as failed, instead of showing a successful start with outdated secret status.
