---
"silo-ui": patch
---

Sandbox setting changes made while another operation is running now apply to the latest settings instead of overwriting concurrent work. Each create, edit, delete, or reorder is sent as a targeted change; if the sandbox changed while your edit was waiting its turn, Silo rejects it with a clear message so you can review and try again.
