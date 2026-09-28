---
"silo-ui": minor
---

Sandbox actions now wait their turn instead of failing when another operation is running. Silo shows what each pending action is waiting for: a per-sandbox "Waiting for…" status and a compact indicator listing running and waiting operations with elapsed time, flagging any operation that has been running unusually long.
