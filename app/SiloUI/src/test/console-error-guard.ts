import { format } from "node:util"
import { beforeEach } from "vitest"

// Known console.error sources that remain allowed until their ledger entry is
// fixed. Each pattern names the entry that removes it; delete the pattern when
// that entry lands. When the guard was introduced these accounted for all 23
// failures across 10 files; everything else fails the test.
const allowedConsoleErrors: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // About 20 tests (production surface, onboarding, status bar, sidebar
    // tooltips, startup) let state updates land after their last assertion.
    pattern: /inside a test was not wrapped in act\(/,
    reason: "K-17: await settled state instead of ending the test mid-update",
  },
  {
    // shutdown-boundary.test.tsx answers every unknown command with `true`, so
    // read_operation_queue fails its schema.
    pattern: /^Silo shutdown queue: ZodError/,
    reason: "K-05: shared native bridge mock that rejects unhandled commands",
  },
]

let recorded: string[] = []

// Wrap console.error directly instead of using vi.spyOn: restoreMocks would
// remove a spy, and a test that silences expected errors with
// vi.spyOn(console, "error").mockImplementation(...) bypasses this wrapper.
export function installConsoleErrorGuard() {
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    recorded.push(format(...args))
    original(...args)
  }
  beforeEach(() => { recorded = [] })
}

export function collectUnexpectedConsoleErrors() {
  const unexpected = recorded.filter(message => !allowedConsoleErrors.some(({ pattern }) => pattern.test(message)))
  recorded = []
  return unexpected
}
