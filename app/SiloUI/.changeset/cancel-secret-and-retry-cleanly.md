---
"silo-ui": patch
---

Cancelling a running operation now stops it cleanly. Cancelling a secret save stops the in-flight runtime command instead of letting it run to completion and then retry, and cancelling a VM start no longer reports the boot-time secret step as an unavailable runtime. Automatic retries of a start, stop, restart, or secret save now honour a cancel across the whole retry sequence, including during the wait before a retry. Cancelling a sandbox action no longer raises a failure notification, since a cancellation is an expected outcome. Start, stop, and restart also re-check the sandbox by its stable identity when their turn arrives, so a rename or removal while waiting is handled correctly.
