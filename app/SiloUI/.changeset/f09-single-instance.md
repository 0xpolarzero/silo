---
"silo-ui": patch
---

Only one Silo runs at a time. Opening Silo again brings the running window forward, including when it is hidden in the menu bar or tray, instead of failing to start. Opening a different Silo build while one is running shows "Silo is already running. Quit it first." A startup failure now explains itself in a dialog instead of closing without a message.
