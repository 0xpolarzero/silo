import { expect, it } from "vitest"
import { formatAbsoluteTime, formatRelativeTime } from "./relative-time"

const now = new Date("2026-09-29T14:05:00Z")

it("formats recent times as short relative phrases", () => {
  expect(formatRelativeTime("2026-09-29T12:05:00Z", now)).toBe("2 hours ago")
  expect(formatRelativeTime("2026-09-29T13:45:00Z", now)).toBe("20 minutes ago")
})

it("uses named days for the previous day", () => {
  expect(formatRelativeTime("2026-09-28T14:05:00Z", now)).toBe("yesterday")
})

it("returns an empty string for an unparseable timestamp", () => {
  expect(formatRelativeTime("not-a-date", now)).toBe("")
})

it("falls back to the raw value when an absolute timestamp cannot be parsed", () => {
  expect(formatAbsoluteTime("not-a-date")).toBe("not-a-date")
})
