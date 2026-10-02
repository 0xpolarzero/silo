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

## Unchanged remote download status

Fixed in `desktop/computer-use-bridge.ts`. The remote ChatGPT download store
previously published every partial update, including unchanged progress and
repeated errors. The `keeps remote download consumers stable until progress or a
read error changes` regression measured ten extra hook renders for ten equal
polls. Comparing the merged snapshot before notifying reduces that to zero.

The test also verifies changed byte counts, a new connection error, repeated
failure without another render, and error clearance after recovery. All 133
focused computer-use, polling and desktop-viewer tests pass. Poll scheduling,
backoff and event/read ordering remain independent of notification suppression.
The same React external-store identity contract above applies. Only deterministic
frontend data was used; no app bundle or real computer was inspected.

## Repeated repository catalog scans

Fixed in `features/github/components/github-access-editor.tsx`. Every repository
picker previously filtered its whole catalog on each render, including while
closed. An absent sandbox selection also supplied a new empty array each render,
invalidating the selected-name cache.

The `does not rescan an unchanged catalog during unrelated renders and picks from
a replacement catalog` regression counts catalog-entry reads through a Proxy.
With 1,000 repositories and ten unrelated notice changes, the old code read
10,000 catalog entries. Cached search results and a stable empty selection reduce
that to zero. A replacement catalog remains selectable with the keyboard.
All 30 focused editor, GitHub-page and onboarding-GitHub tests pass, covering
search, selected repository identity, and catalog replacement.

React's [useMemo contract](https://react.dev/reference/react/useMemo) caches pure
calculations while their dependencies retain identity. Consulted 2026-10-02.
Filtering depends on the catalog, selected-name set, and query, and event-driven
search still computes fresh results for new text. The measured result concerns
catalog reads; option element construction and large-list DOM costs remain.

Merge verification: all 34 editor, GitHub-page and onboarding-GitHub tests pass
with `--maxWorkers=1 --testTimeout=15000`. The default five-second limit timed
out twice in the existing identity-edit interaction; the isolated interaction
completed in 8.2 seconds with the longer limit. Original failures remain in
`/tmp/silo-catalog-rerenders-merge*.log`. Typecheck, touched-file lint, formatting,
and whitespace checks pass. The merge preserves own-property checks for sandbox
names such as `constructor` alongside the stable empty-selection fallback.

## Unchanged sandbox computer-use state

Fixed in `desktop/computer-use-panel.tsx`. The sandbox's own five-second health
read previously replaced panel state even when approval, readiness and details
were unchanged. This is separate from the computer's download-status store.

The `does not commit the computer-use panel for equal reads but shows changed
approval` regression profiles the real panel with deterministic native replies.
Ten equal polls caused ten React commits before the fix and zero after it.
Changing approval to Auto on the following poll still checks the switch and
produces one commit. All 125 focused computer-use and polling tests pass, including
optimistic commands, errors, retries, stale reads, backoff and hidden views.
The equality check only affects successful background reads; error clearance,
revision guards and explicit actions retain their independent behavior. No
latency, live sandbox or installed-app claim follows from these fixture counts.
