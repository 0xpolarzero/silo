---
"silo-ui": patch
---

An interrupted or failed checkpoint Restore no longer leaves a sandbox stuck. If pausing the sandbox fails before its recovery checkpoint exists, the Restore is abandoned and the sandbox can be started and stopped again. If the sandbox stopped or crashed while its recovery checkpoint was being captured, retrying the Restore now saves a disk recovery checkpoint and finishes. Restore failures now show their real cause instead of "Silo closed during this operation", a failed save of checkpoint history no longer hides the original error, and a temporary runtime error no longer drops an interrupted checkpoint from the history.
