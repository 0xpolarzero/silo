# Frontend polling render measurements

## Unchanged production snapshots

Fixed in `desktop/production-source.ts`. The native bridge returns new objects on
each read, and `publish` previously derived and notified a new view unconditionally.
Both main-window subscribers use this snapshot, so identical reads invalidated
their application trees.

The `does not rerender subscribers during ten unchanged polling ticks` regression
uses the real source and React binding with cloned, deterministic bridge replies.
Before the fix, ten 10-second ticks produced 40 notifications and 40 extra hook
renders. After the fix, the same ten native reads produce zero notifications and
zero extra renders. The changed-GitHub-state control still publishes a new value.
The four source, lifecycle and transfer suites passed all 149 tests.

Keep the authoritative base current and derive overlays before comparing the
serialized view. Reuse the published view when equal; cached JSON equality follows
the existing settings-store pattern and requires no dependency. Comparison still
costs one serialization per attempted publication and retains one serialized view.
Changed metadata, including remote `lastSeen`, remains a real snapshot change.
This measures React invalidations, not native read time, CPU, or live VM health.

React's [useSyncExternalStore contract](https://react.dev/reference/react/useSyncExternalStore)
requires unchanged store data to retain snapshot identity; React compares snapshots
with `Object.is` and renders when that identity changes. Consulted 2026-10-02.
