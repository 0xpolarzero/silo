# Effect cleanup findings

React's [StrictMode documentation](https://react.dev/reference/react/StrictMode#fixing-bugs-found-by-re-running-effects-in-development) specifies an extra setup and cleanup cycle in development. Cleanup must release resources and let the next setup recreate them.

## Lifecycle progress ownership

`useLifecycleToasts` cancelled its delayed timer but retained the tracking entry. StrictMode's second setup found that entry and never scheduled progress again. Disabling notifications did not cancel pending timers, and unmounting left displayed progress notifications behind.

Cleanup now clears timers, dismisses owned progress, and clears tracking entries when notifications are disabled or the owner unmounts. `use-lifecycle-toasts.test.tsx` verifies StrictMode setup replay, disabling and re-enabling, and visible progress disposal with deterministic fixtures and fake timers.

## Pending notice registration

`listenForNotices` disposed late registrations but did not guard their callbacks. A disposed view could still show backend notifications before registration settled, or through an already queued callback. The existing expected-failure diagnostic reproduced this. It now runs as an ordinary regression and delivers events both before and after late registration resolves; the stopped callback ignores both.

## Clipboard feedback timers

`CopyButton` cleared the current timer on unmount but an unfinished clipboard write could create another timer afterward. Two overlapping writes could overwrite the timer handle and show feedback from an older request. A request revision now invalidates pending feedback on unmount and gives only the latest write ownership of status and its reset timer. Deferred clipboard regressions cover late success, late failure, and out-of-order completion.

## Production source startup subscriptions

`startLiveUpdates` awaited six registrations before checking disposal. A registration completing after disposal stayed active until every later registration completed, and previously acquired handles were released twice. Startup now checks disposal immediately after each registration, stops the late handle, and skips subsequent registrations. Disposal drains the owned handle list, and callbacks ignore disposed sources. Deferred registration tests cover the first, middle, and final registration boundaries without invoking native reads.

## Main route consumption after cleanup

`useMainRoute` guarded state publication but still called `take_main_route` after disposal. The native command consumes the pending route with `Option::take` in `status_panel.rs`, so the obsolete listener discarded navigation intended for the active listener. A StrictMode regression with deferred registrations reproduces the missing route. The receiver now checks disposal before consuming native state.

## Tray panel event lifetime

`StatusPanel` forwarded open events after cleanup and left registration rejection unhandled. Under StrictMode, its obsolete listener could focus and reset the active view while registration was pending. The effect now guards callbacks, releases late registrations, and handles rejection. Fixture tests verify one live focus callback, disposal of both replayed registrations, no callback after unmount, and a handled registration error.
