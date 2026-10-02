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

## Unchanged update status

Fixed in `features/updates/update-store.tsx`. While an update is ready, the provider
reads the installation gate every three seconds. Each reply previously replaced
snapshot state and recreated context, including for the application consumer.

The `keeps consumers stable across equal polls and events but updates the
installation gate` regression measured 11 extra consumer renders for ten equal
polls and one equal event. Retaining equal state reduces that to zero. The test
then changes the installation gate through polling and events and verifies the
button disables and enables. All 52 focused update/provider/desktop tests pass.
The generation counter still advances on equal replies, preserving stale-response
rejection. Pending actions and connection errors still update independently.

React's [useState bailout](https://react.dev/reference/react/useState#setstate) skips
children when the next state is identical; [context propagation](https://react.dev/reference/react/useContext#optimizing-re-renders-when-passing-objects-and-functions)
otherwise updates consumers whenever the provider passes a new object. Consulted
2026-10-02. These fixture counts establish avoided renders, not a CPU benchmark.
