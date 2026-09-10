import { describe, expect, it } from "vitest"
import { desktopShortcutCommand, shortcutFor } from "./shortcuts"

describe("desktop shortcuts", () => {
  it.each([
    ["1", "go-sandboxes"], ["2", "go-files"], ["3", "go-logs"], ["4", "go-network"],
    ["5", "go-activity"], ["6", "go-github"], ["7", "go-secrets"], ["8", "go-backup"],
  ])("routes Control-%s to %s", (key, command) => {
    expect(desktopShortcutCommand(new KeyboardEvent("keydown", { key, ctrlKey: true }))).toBe(command)
  })
  it("does not steal typing, another modifier chord, repeats, composition or search", () => {
    for (const init of [{ key: "1" }, { key: "B", ctrlKey: true, shiftKey: true }, { key: "1", ctrlKey: true, repeat: true },
      { key: "1", ctrlKey: true, isComposing: true }, { key: "k", ctrlKey: true }]) {
      expect(desktopShortcutCommand(new KeyboardEvent("keydown", init))).toBeUndefined()
    }
  })
  it("accepts Shift needed to type digits on French layouts", () => {
    expect(desktopShortcutCommand(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, shiftKey: true }))).toBe("go-sandboxes")
  })
  it("shows only configured shortcuts with platform-appropriate labels", () => {
    expect(shortcutFor("go-files", "MacIntel")).toEqual({ keys: ["⌘", "2"], aria: "Meta+2" })
    expect(shortcutFor("go-files", "Linux x86_64")).toEqual({ keys: ["Ctrl", "2"], aria: "Control+2" })
    expect(shortcutFor("notifications", "MacIntel")).toBeUndefined()
  })
})
