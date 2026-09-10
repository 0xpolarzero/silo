import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }))

import { connectSettingsLifecycle, createDesktopSettingsStore } from "./settings"
import { fixtureMachineDefaults } from "@/fixtures/machine-configurations"
import type { OnboardingDraft } from "@/features/onboarding/model/onboarding-draft"

const cleanups: (() => void)[] = []
const snapshot = (revision = 0, settings: Record<string, unknown> = {}, saveError: string | null = null) => ({
  revision, settings, onboardingDraft: null, saveError,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function store(main = true) {
  const value = createDesktopSettingsStore({}, main)
  cleanups.push(value.dispose)
  return value
}

beforeEach(() => {
  native.invoke.mockReset()
  native.listen.mockReset()
  native.handlers.clear()
  localStorage.clear()
  native.listen.mockImplementation(async (event: string, receive: (event: { payload: unknown }) => void) => {
    native.handlers.set(event, receive)
    return () => { native.handlers.delete(event) }
  })
})

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.restoreAllMocks()
})

describe("native settings transport", () => {
  it("imports a saved legacy theme only when absent, keeping its original storage key", async () => {
    localStorage.setItem("silo-theme", "dark")
    native.invoke.mockImplementation(async (command: string) => command === "import_legacy_theme"
      ? snapshot(1, { theme: "dark" }) : snapshot())
    const settings = store()
    await settings.initialize()
    expect(settings.getSnapshot().settings.theme).toBe("dark")
    expect(native.invoke).toHaveBeenCalledWith("import_legacy_theme", { theme: "dark" })
    expect(localStorage.getItem("silo-theme")).toBe("dark")
    await settings.refresh()
    expect(native.invoke.mock.calls.filter(([command]) => command === "import_legacy_theme")).toHaveLength(1)
  })

  it.each([
    { main: true, settings: { theme: "light" }, error: null, legacy: "dark" },
    { main: true, settings: { theme: "invalid-saved-value" }, error: null, legacy: "dark" },
    { main: true, settings: {}, error: "File protected", legacy: "dark" },
    { main: true, settings: {}, error: null, legacy: "invalid-legacy-value" },
    { main: false, settings: {}, error: null, legacy: "dark" },
  ])("does not overwrite saved values or import from a status window ($main, $legacy, $error)", async (input) => {
    localStorage.setItem("silo-theme", input.legacy)
    native.invoke.mockResolvedValue(snapshot(0, input.settings, input.error))
    await store(input.main).initialize()
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("read_settings")
    expect(localStorage.getItem("silo-theme")).toBe(input.legacy)
  })

  it("subscribes before reading and ignores stale read results and events", async () => {
    const calls: string[] = []
    native.listen.mockImplementation(async (event: string, receive: (event: { payload: unknown }) => void) => {
      calls.push(event)
      native.handlers.set(event, receive)
      return () => { native.handlers.delete(event) }
    })
    native.invoke.mockImplementation(async (command: string) => {
      calls.push(command)
      native.handlers.get("settings:changed")?.({ payload: snapshot(2, { theme: "dark" }) })
      return snapshot(1, { theme: "light" })
    })
    const settings = store()
    await settings.initialize()
    expect(calls).toEqual(["settings:changed", "read_settings"])
    expect(settings.getSnapshot().settings.theme).toBe("dark")
    native.handlers.get("settings:changed")?.({ payload: snapshot(0, { theme: "system" }) })
    expect(settings.getSnapshot().settings.theme).toBe("dark")
  })

  it("refreshes a reopened status panel and removes lifecycle listeners on cleanup", async () => {
    let state = snapshot()
    native.invoke.mockImplementation(async () => state)
    const settings = store(false)
    await settings.initialize()
    const stop = await connectSettingsLifecycle(settings, false)
    cleanups.push(stop)
    state = snapshot(1, { editor: "Cursor" })
    native.handlers.get("desktop:status-opened")?.({ payload: null })
    await vi.waitFor(() => expect(settings.getSnapshot().settings.editor).toBe("Cursor"))
    state = snapshot(2, { editor: "Zed" })
    window.dispatchEvent(new Event("focus"))
    await vi.waitFor(() => expect(settings.getSnapshot().settings.editor).toBe("Zed"))
    stop()
    native.invoke.mockClear()
    window.dispatchEvent(new Event("focus"))
    expect(native.handlers.has("desktop:status-opened")).toBe(false)
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it("reconnects change events after an initial subscription failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    native.listen.mockRejectedValueOnce(new Error("Event bridge not ready"))
    native.invoke.mockResolvedValue(snapshot(1, { theme: "dark" }))
    const settings = store()
    await settings.initialize()
    expect(settings.getSnapshot().saveError).toBe("Event bridge not ready")
    await settings.refresh()
    expect(native.handlers.has("settings:changed")).toBe(true)
    native.handlers.get("settings:changed")?.({ payload: snapshot(2, { theme: "light" }) })
    expect(settings.getSnapshot().settings.theme).toBe("light")
    expect(settings.getSnapshot().saveError).toBeNull()
  })

  it("keeps startup usable when the lifecycle event bridge temporarily fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    native.invoke.mockResolvedValue(snapshot())
    const settings = store()
    await settings.initialize()
    native.listen.mockRejectedValueOnce(new Error("Lifecycle bridge not ready"))
    const stop = await connectSettingsLifecycle(settings, true)
    cleanups.push(stop)
    window.dispatchEvent(new Event("focus"))
    await vi.waitFor(() => expect(native.handlers.has("settings:flush-request")).toBe(true))
  })

  it("waits for setup work after claiming shutdown and before flushing settings", async () => {
    native.invoke.mockResolvedValue(snapshot())
    const settings = store()
    await settings.initialize()
    const setup = deferred<void>()
    const beforeFlush = vi.fn(() => setup.promise)
    cleanups.push(await connectSettingsLifecycle(settings, true, beforeFlush))
    native.handlers.get("settings:flush-request")?.({ payload: null })
    await vi.waitFor(() => expect(beforeFlush).toHaveBeenCalledOnce())
    expect(native.invoke).toHaveBeenCalledWith("begin_settings_flush")
    expect(native.invoke).not.toHaveBeenCalledWith("flush_settings")
    expect(native.invoke).not.toHaveBeenCalledWith("complete_settings_flush")
    setup.resolve()
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("complete_settings_flush"))
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      "read_settings", "begin_settings_flush", "flush_settings", "read_settings", "complete_settings_flush",
    ])
  })

  it("waits for pending updates before acknowledging normal Quit", async () => {
    const write = deferred<ReturnType<typeof snapshot>>()
    let state = snapshot()
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "update_settings") { state = await write.promise; return state }
      if (command === "read_settings") return state
    })
    const settings = store()
    await settings.initialize()
    cleanups.push(await connectSettingsLifecycle(settings, true))
    const updating = settings.updateSettings({ browser: "Firefox" })
    native.handlers.get("settings:flush-request")?.({ payload: null })
    expect(native.invoke).toHaveBeenCalledWith("begin_settings_flush")
    expect(native.invoke).not.toHaveBeenCalledWith("flush_settings")
    expect(native.invoke).not.toHaveBeenCalledWith("complete_settings_flush")
    write.resolve(snapshot(1, { browser: "Firefox" }))
    await updating
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("complete_settings_flush"))
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      "read_settings", "update_settings", "begin_settings_flush", "flush_settings", "read_settings", "complete_settings_flush",
    ])
  })

  it("drains a change queued in the microtask after an earlier write completes", async () => {
    let state = snapshot()
    native.invoke.mockImplementation(async (command: string, args?: { patch?: Record<string, unknown> }) => {
      if (command === "update_settings") state = snapshot(state.revision + 1, { ...state.settings, ...args?.patch })
      return state
    })
    const settings = store()
    await settings.initialize()
    let added = false
    settings.subscribe(() => {
      if (!added && settings.getSnapshot().revision === 1) {
        added = true
        queueMicrotask(() => { void settings.updateSettings({ browser: "Firefox" }) })
      }
    })
    await settings.updateSettings({ terminal: "iTerm" })
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("update_settings", { patch: { browser: "Firefox" } }))
    expect(state.settings).toEqual({ terminal: "iTerm", browser: "Firefox" })
  })

  it("cancels Quit when pending changes cannot be flushed so another attempt is possible", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "read_settings") return snapshot()
      if (command === "flush_settings") throw new Error("Disk full")
    })
    const settings = store()
    await settings.initialize()
    cleanups.push(await connectSettingsLifecycle(settings, true))
    native.handlers.get("settings:flush-request")?.({ payload: null })
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("cancel_settings_flush"))
    expect(native.invoke).not.toHaveBeenCalledWith("complete_settings_flush")
  })

  it("includes changes made while the final native flush is running before acknowledging Quit", async () => {
    const flushStarted = deferred<void>()
    const finishFlush = deferred<void>()
    const finishWrite = deferred<ReturnType<typeof snapshot>>()
    let state = snapshot()
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "read_settings") return state
      if (command === "flush_settings") { flushStarted.resolve(); await finishFlush.promise }
      if (command === "update_settings") { state = await finishWrite.promise; return state }
    })
    const settings = store()
    await settings.initialize()
    cleanups.push(await connectSettingsLifecycle(settings, true))
    native.handlers.get("settings:flush-request")?.({ payload: null })
    await flushStarted.promise
    const updating = settings.updateSettings({ browser: "Firefox" })
    finishFlush.resolve()
    // Let the resolved flush and read promises finish while the write is held.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    try {
      expect(native.invoke).not.toHaveBeenCalledWith("complete_settings_flush")
    } finally {
      finishWrite.resolve(snapshot(1, { browser: "Firefox" }))
      await updating
    }
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("complete_settings_flush"))
  })

  it("rejects an oversized draft without replacing recovery data or blocking later valid preferences", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const savedDraft: OnboardingDraft = {
      currentStep: "github",
      machines: [...fixtureMachineDefaults],
      unfinishedMachineEditor: null,
      workspaceSelections: {},
      workspaceIdentities: { dev: { name: "Saved author", email: "saved@example.com", apply: true } },
    }
    let state = { ...snapshot(), onboardingDraft: savedDraft }
    native.invoke.mockImplementation(async (command: string, args?: { patch?: Record<string, unknown> }) => {
      if (command === "update_settings") state = { ...state, revision: state.revision + 1, settings: { ...state.settings, ...args?.patch } }
      return state
    })
    const settings = store()
    await settings.initialize()
    await settings.updateOnboardingDraft({
      ...savedDraft,
      workspaceIdentities: { dev: { ...savedDraft.workspaceIdentities.dev, name: "😀".repeat(70_000) } },
    })
    expect(settings.getSnapshot().saveError).toBe("Onboarding draft is too large to save")
    expect(settings.getSnapshot().onboardingDraft).toEqual(savedDraft)
    expect(native.invoke.mock.calls.some(([command]) => command === "update_onboarding_draft")).toBe(false)

    await settings.updateSettings({ browser: "Firefox" })
    await settings.flush()
    expect(native.invoke).toHaveBeenCalledWith("update_settings", { patch: { browser: "Firefox" } })
    expect(state.settings.browser).toBe("Firefox")
    expect(state.onboardingDraft).toEqual(savedDraft)
    expect(settings.getSnapshot().saveError).toBeNull()
  })
})
