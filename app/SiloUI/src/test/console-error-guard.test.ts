import { expect, it, vi } from "vitest"
import { collectUnexpectedConsoleErrors } from "./console-error-guard"

// The dom setup fails a test on unexpected console.error; these tests drain the
// recorded messages themselves so the guard's own behaviour stays checked.
it("records unexpected console.error calls", () => {
  console.error("boom from %s", "test")
  expect(collectUnexpectedConsoleErrors()).toEqual(["boom from test"])
})

it("records unsettled React updates as unexpected errors", () => {
  const warning = "Warning: An update to Probe inside a test was not wrapped in act(...)."
  console.error(warning)
  expect(collectUnexpectedConsoleErrors()).toEqual([warning])
})

it("lets a test silence expected errors with a spy", () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  console.error("expected failure")
  expect(collectUnexpectedConsoleErrors()).toEqual([])
})
