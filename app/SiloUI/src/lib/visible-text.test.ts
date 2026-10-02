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

  it("reveals soft hyphens in otherwise identical file names", () => {
    expect(visibleText("con\u00ADfig.json")).toBe("con⟨U+00AD⟩fig.json")
    expect(visibleText("config.json")).toBe("config.json")
  })

  it.each([
    ["034F", "\u034F"], ["180E", "\u180E"], ["3164", "\u3164"],
    ["FE0F", "\uFE0F"], ["E0061", "\u{E0061}"], ["E0100", "\u{E0100}"],
  ])("reveals default-ignorable U+%s in a guest name", (code, character) => {
    expect(visibleText(`con${character}fig`)).toBe(`con⟨U+${code}⟩fig`)
  })

  it("leaves ordinary names, including non-Latin ones, unchanged", () => {
    for (const name of ["acme/silo", "projects/my app", "données", "donne\u0301es", "项目", "שלום", "📁"]) expect(visibleText(name)).toBe(name)
  })
})
