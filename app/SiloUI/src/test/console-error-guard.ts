import { format } from "node:util"
import { beforeEach } from "vitest"

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
  const unexpected = recorded
  recorded = []
  return unexpected
}
