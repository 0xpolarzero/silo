import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it, vi } from "vitest"

// The script Silo injects into every frame of a guest desktop webview (G-20).
// It locks what it guards, so it runs once, as it does in a real frame.
const native = resolve(dirname(fileURLToPath(import.meta.url)), "../../src-tauri")
const guard = readFileSync(resolve(native, "src/desktop_viewer_guard.js"), "utf8")

class FakeClipboard {
  writeText = vi.fn(async () => {})
  readText = vi.fn(async () => "host secret")
  write = vi.fn(async () => {})
  read = vi.fn(async () => [])
}
const clipboard = new FakeClipboard()
const original = { ...clipboard }
const execCommand = vi.fn(() => true)

beforeAll(() => {
  vi.stubGlobal("Clipboard", FakeClipboard)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard })
  Object.defineProperty(Document.prototype, "execCommand", { configurable: true, writable: true, value: execCommand })
  window.eval(guard)
})

describe("guest desktop clipboard guard", () => {
  it("refuses clipboard reads and writes before guest scripts run", async () => {
    await expect(navigator.clipboard.writeText("payload")).rejects.toMatchObject({ name: "NotAllowedError" })
    await expect(navigator.clipboard.readText()).rejects.toMatchObject({ name: "NotAllowedError" })
    await expect(navigator.clipboard.write([])).rejects.toMatchObject({ name: "NotAllowedError" })
    await expect(navigator.clipboard.read()).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(original.writeText).not.toHaveBeenCalled()
    expect(original.readText).not.toHaveBeenCalled()
    // A guest script cannot put the originals back.
    expect(() => { Object.defineProperty(navigator.clipboard, "writeText", { value: original.writeText }) }).toThrow()
    expect(() => { Object.defineProperty(FakeClipboard.prototype, "writeText", { value: original.writeText }) }).toThrow()
  })

  it("stops page-driven copy while leaving other editing commands alone", () => {
    expect(document.execCommand("copy")).toBe(false)
    expect(document.execCommand("CUT")).toBe(false)
    expect(document.execCommand("paste")).toBe(false)
    expect(execCommand).not.toHaveBeenCalled()
    expect(document.execCommand("bold")).toBe(true)
    expect(execCommand).toHaveBeenCalledOnce()
    expect(() => { Object.defineProperty(Document.prototype, "execCommand", { value: execCommand }) }).toThrow()
  })

  it("keeps guest handlers from replacing copied data but lets pasting through", () => {
    const handler = vi.fn()
    document.addEventListener("copy", handler)
    document.addEventListener("cut", handler)
    document.dispatchEvent(new Event("copy", { bubbles: true }))
    document.dispatchEvent(new Event("cut", { bubbles: true }))
    expect(handler).not.toHaveBeenCalled()
    const paste = vi.fn()
    document.addEventListener("paste", paste)
    document.dispatchEvent(new Event("paste", { bubbles: true }))
    expect(paste).toHaveBeenCalledOnce()
  })
})
