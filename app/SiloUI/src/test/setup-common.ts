import { afterEach, vi } from "vitest"

// A test that fails before restoring real timers must not leave fake timers
// installed for the next test in the same file.
afterEach(() => {
  vi.useRealTimers()
})
