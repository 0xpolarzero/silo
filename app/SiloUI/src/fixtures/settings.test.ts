import { describe, expect, it } from "vitest"

import { hasSettingsFixture } from "./settings"

describe("native settings fixture selection", () => {
  it("isolates explicit scenarios while leaving view-only native presentation real", () => {
    expect(hasSettingsFixture("?scenario=complete")).toBe(true)
    expect(hasSettingsFixture("?view=onboarding")).toBe(false)
    expect(hasSettingsFixture("?native-status")).toBe(false)
  })
})
