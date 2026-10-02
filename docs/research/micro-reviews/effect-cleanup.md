# Effect cleanup findings

React's [StrictMode documentation](https://react.dev/reference/react/StrictMode#fixing-bugs-found-by-re-running-effects-in-development) specifies an extra setup and cleanup cycle in development. Cleanup must release resources and let the next setup recreate them.

## Lifecycle progress ownership

`useLifecycleToasts` cancelled its delayed timer but retained the tracking entry. StrictMode's second setup found that entry and never scheduled progress again. Disabling notifications did not cancel pending timers, and unmounting left displayed progress notifications behind.

Cleanup now clears timers, dismisses owned progress, and clears tracking entries when notifications are disabled or the owner unmounts. `use-lifecycle-toasts.test.tsx` verifies StrictMode setup replay, disabling and re-enabling, and visible progress disposal with deterministic fixtures and fake timers.
