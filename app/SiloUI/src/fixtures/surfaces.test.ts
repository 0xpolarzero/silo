import { describe, expect, it } from "vitest"

import { surfaceFromSearch } from "@/fixtures/surfaces"

describe("surface fixtures", () => {
  it("defaults to onboarding and accepts every preview surface", () => {
    expect(surfaceFromSearch("")).toBe("onboarding")
    expect(surfaceFromSearch("?view=unknown")).toBe("onboarding")
    expect(surfaceFromSearch("?view=onboarding")).toBe("onboarding")
    expect(surfaceFromSearch("?view=app")).toBe("app")
    expect(surfaceFromSearch("?view=status-bar")).toBe("status-bar")
  })
})
