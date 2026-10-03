import { describe, expect, it } from "vitest"
import { parseLinuxDesktopState } from "./linux-desktop-state"

describe("parseLinuxDesktopState", () => {
  it("keeps the state the backend reports for a stopped computer that has a desktop", () => {
    expect(parseLinuxDesktopState({ installed: true, state: "computer-stopped", autoStart: false }).state).toBe("computer-stopped")
  })

  it("derives the state from the X session otherwise", () => {
    expect(parseLinuxDesktopState({ installed: true, state: "running", sessionState: "failed", autoStart: true }).state).toBe("failed")
  })
})
