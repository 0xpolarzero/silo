---
"silo-ui": patch
---

Background housekeeping no longer flashes a status above the sandbox list. Internal
maintenance such as clearing expired logs, reconciling SSH access, trimming storage, and
reconciling ports still runs under the same mutual-exclusion gate, but it is now hidden from
the operation queue so it never shifts the list. Longer-running operations you started now
appear as a single notification instead of an inline panel: it waits until an operation has
been active briefly (so quick actions never flash), shows the running label or a count with
elapsed time, flags anything taking longer than expected, lists what is waiting, and offers
Cancel for a cancellable operation. Export and import keep their own progress notification. A
sandbox waiting behind hidden maintenance now reads "Waiting for background maintenance…".
