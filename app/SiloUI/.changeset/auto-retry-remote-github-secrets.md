---
"silo-ui": patch
---

Automatic retry after a temporary failure now covers more safe actions: starting, stopping, or restarting a VM from a remote computer, applying a sandbox's GitHub Git identity, and saving a sandbox's secrets. Each retry re-runs the same intent against fresh state and only retries genuinely transient failures, such as a timed-out or momentarily unavailable runtime; validation, rejection, and verification failures still stop immediately. Port forwarding is unchanged: its failures are deterministic, so it does not retry.
