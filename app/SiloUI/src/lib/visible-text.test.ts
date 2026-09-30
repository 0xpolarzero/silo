import { describe, expect, it } from "vitest"

import { visibleText } from "./visible-text"

describe("visible text for guest-controlled names", () => {
  it("reveals bidirectional overrides, isolates and marks", () => {
    expect(visibleText("invoice\u202Egpj.exe")).toBe("invoice⟨U+202E⟩gpj.exe")
    expect(visibleText("\u2066acme\u2069/\u200Fsilo")).toBe("⟨U+2066⟩acme⟨U+2069⟩/⟨U+200F⟩silo")
  })

  it("reveals zero-width, byte-order and control characters", () => {
    expect(visibleText("ac\u200Bme/si\uFEFFlo")).toBe("ac⟨U+200B⟩me/si⟨U+FEFF⟩lo")
    expect(visibleText("line\nbreak\u0007\u009B")).toBe("line⟨U+000A⟩break⟨U+0007⟩⟨U+009B⟩")
  })

  it("leaves ordinary names, including non-Latin ones, unchanged", () => {
    for (const name of ["acme/silo", "projects/my app", "données", "项目", "שלום"]) expect(visibleText(name)).toBe(name)
  })
})
