import { describe, expect, it } from "vitest"
import { createMemorySettingsStore, createSettingsStore, type SettingsBackend, type SettingsSnapshot } from "./settings-store"

const snapshot = (revision = 0, settings = {}): SettingsSnapshot => ({ revision, settings, onboardingDraft: null, saveError: null })

describe("settings synchronization", () => {
  it("follows system application defaults after opting in without erasing the saved custom choice", async () => {
    let state = snapshot(0, { editor: "Custom", editorPath: "/Applications/Custom.app" })
    const store = createSettingsStore({
      subscribe: async () => () => {}, read: async () => state,
      updateSettings: async (patch) => { state = snapshot(state.revision + 1, { ...state.settings, ...patch }); return state },
      updateOnboardingDraft: async () => state, flush: async () => {},
    })
    await store.initialize()
    store.updateDefaults({ editor: "Zed", editorPath: "/Applications/Zed.app" })
    expect(store.getSnapshot().settings).toMatchObject({ editor: "Custom", editorUseSystemDefault: false })
    await store.updateSettings({ editorUseSystemDefault: true })
    expect(store.getSnapshot().settings).toMatchObject({ editor: "Zed", editorPath: "/Applications/Zed.app", editorUseSystemDefault: true })
    store.updateDefaults({ editor: "Cursor", editorPath: "/Applications/Cursor.app" })
    expect(store.getSnapshot().settings.editor).toBe("Cursor")
    expect(state.settings).toEqual({ editor: "Custom", editorPath: "/Applications/Custom.app", editorUseSystemDefault: true })
    await store.updateSettings({ editorUseSystemDefault: false })
    expect(store.getSnapshot().settings).toMatchObject({ editor: "Custom", editorPath: "/Applications/Custom.app" })
  })

  it("keeps explicit false and empty selections across a new store session", async () => {
    const first = createMemorySettingsStore()
    await first.updateSettings({ launchAtLogin: false, startupWorkspaceIds: [], notifyHealth: false, editor: "Cursor" })
    const second = createMemorySettingsStore(first.getSnapshot().settings)
    expect(second.getSnapshot().settings).toMatchObject({ launchAtLogin: false, startupWorkspaceIds: [], notifyHealth: false, editor: "Cursor" })
  })

  it("subscribes before reading and ignores an older initial read", async () => {
    let listener: (value: SettingsSnapshot) => void = () => {}
    const backend: SettingsBackend = {
      subscribe: async (receive) => { listener = receive; return () => {} },
      read: async () => { listener(snapshot(2, { theme: "dark" })); return snapshot(1, { theme: "light" }) },
      updateSettings: async () => snapshot(), updateOnboardingDraft: async () => snapshot(), flush: async () => {},
    }
    const store = createSettingsStore(backend)
    await store.initialize()
    expect(store.getSnapshot().settings.theme).toBe("dark")
  })

  it("keeps rapid changes visible and writes patches in order", async () => {
    let release!: () => void
    let state = snapshot()
    const patches: unknown[] = []
    const backend: SettingsBackend = {
      subscribe: async () => () => {}, read: async () => state,
      updateSettings: async (patch) => {
        patches.push(patch)
        if (patches.length === 1) await new Promise<void>((resolve) => { release = resolve })
        state = snapshot(state.revision + 1, { ...state.settings, ...patch })
        return state
      },
      updateOnboardingDraft: async () => state, flush: async () => {},
    }
    const store = createSettingsStore(backend)
    await store.initialize()
    const first = store.updateSettings({ terminal: "iTerm" })
    const second = store.updateSettings({ browser: "Firefox" })
    expect(store.getSnapshot().settings).toMatchObject({ terminal: "iTerm", browser: "Firefox" })
    release()
    await Promise.all([first, second])
    expect(patches).toEqual([{ terminal: "iTerm" }, { browser: "Firefox" }])
    expect(store.getSnapshot().settings).toMatchObject({ terminal: "iTerm", browser: "Firefox" })
  })

  it("keeps a pending explicit empty selection when session defaults change", async () => {
    let release!: () => void
    let state = snapshot()
    let writes = 0
    const store = createSettingsStore({
      subscribe: async () => () => {}, read: async () => state,
      updateSettings: async (patch) => {
        writes += 1
        await new Promise<void>((resolve) => { release = resolve })
        state = snapshot(1, patch)
        return state
      },
      updateOnboardingDraft: async () => state, flush: async () => {},
    }, { startupWorkspaceIds: ["initial-dev"] })
    await store.initialize()
    const pending = store.updateSettings({ startupWorkspaceIds: [] })
    store.updateDefaults({ startupWorkspaceIds: ["new-dev"] })
    expect(store.getSnapshot().settings.startupWorkspaceIds).toEqual([])
    release()
    await pending
    store.updateDefaults({ startupWorkspaceIds: ["another-dev"] })
    expect(store.getSnapshot().settings.startupWorkspaceIds).toEqual([])
    expect(writes).toBe(1)
  })

  it("retries an unsent change during flush without losing the session selection", async () => {
    let attempts = 0
    const backend: SettingsBackend = {
      subscribe: async () => () => {}, read: async () => snapshot(),
      updateSettings: async (patch) => { if (++attempts === 1) throw new Error("IPC unavailable"); return snapshot(1, patch) },
      updateOnboardingDraft: async () => snapshot(), flush: async () => {},
    }
    const store = createSettingsStore(backend)
    await store.initialize()
    await store.updateSettings({ theme: "dark" })
    expect(store.getSnapshot().settings.theme).toBe("dark")
    expect(store.getSnapshot().saveError).toBe("IPC unavailable")
    await store.flush()
    expect(store.getSnapshot().saveError).toBeNull()
    expect(attempts).toBe(2)
  })
})
