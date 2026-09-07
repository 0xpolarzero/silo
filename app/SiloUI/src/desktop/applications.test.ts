import { beforeEach, expect, it, vi } from "vitest"
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
import { createApplicationService } from "./applications"
import { createMemorySettingsStore, createSettingsStore, type SettingsBackend, type SettingsSnapshot } from "@/features/preferences/settings-store"
import type { SettingsPatch } from "@/features/preferences/model/settings"
import { fixtureApplicationCatalog } from "@/fixtures/application-catalog"

const terminal = { name: "Ghostty", path: "/Applications/Ghostty.app" }
const editor = { name: "Zed", path: "/Applications/Zed.app" }
const browser = { name: "Firefox", path: "/Applications/Firefox.app" }
const catalog = { terminal: [terminal], editor: [editor], browser: [browser], defaults: { browser: browser.path }, fixture: false }
const kinds = ["terminal", "editor", "browser"] as const
beforeEach(() => { native.invoke.mockReset() })

function persistedSettings(saved: Record<string, unknown> = {}) {
  let snapshot: SettingsSnapshot = { revision: 0, settings: structuredClone(saved), onboardingDraft: null, saveError: null }
  const listeners = new Set<(snapshot: SettingsSnapshot) => void>()
  const backend: SettingsBackend = {
    read: async () => structuredClone(snapshot),
    subscribe: async (receive) => { listeners.add(receive); return () => { listeners.delete(receive) } },
    updateSettings: vi.fn(async (patch: SettingsPatch) => {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, settings: { ...snapshot.settings, ...patch } }
      listeners.forEach((receive) => receive(structuredClone(snapshot)))
      return structuredClone(snapshot)
    }),
    updateOnboardingDraft: async () => structuredClone(snapshot),
    flush: async () => {},
  }
  return { backend, bytes: () => JSON.stringify(snapshot) }
}

it("uses installed defaults without saving them or overwriting existing choices", async () => {
  native.invoke.mockResolvedValue(catalog)
  const store = createMemorySettingsStore({ terminal: "Old Terminal", terminalPath: "/Applications/Old.app" })
  const write = vi.spyOn(store, "updateSettings")
  await createApplicationService(store).read()
  expect(native.invoke).toHaveBeenCalledWith("list_applications", { selections: { terminal: "/Applications/Old.app" } })
  expect(store.getSnapshot().settings).toMatchObject({ terminal: "Old Terminal", terminalPath: "/Applications/Old.app", editor: "Zed", browser: "Firefox" })
  expect(write).not.toHaveBeenCalled()
})

it("uses deterministic choices when native storage reports fixture mode", async () => {
  native.invoke.mockResolvedValue({ ...catalog, terminal: [], editor: [], browser: [], fixture: true })
  const store = createMemorySettingsStore()
  expect(await createApplicationService(store).read()).toEqual(fixtureApplicationCatalog)
  expect(store.getSnapshot().settings.terminal).toBe("Terminal")
})

it("resolves the same exact default in both windows while retaining legacy name-only choices", async () => {
  const first = { name: "Editor", path: "/Applications/Editor.app" }
  const preferred = { name: "Editor", path: "/Users/example/Applications/Editor.app" }
  native.invoke.mockResolvedValue({ ...catalog, editor: [first, preferred], defaults: { editor: preferred.path } })
  const main = createMemorySettingsStore()
  const status = createMemorySettingsStore()
  await Promise.all([createApplicationService(main).read(), createApplicationService(status).read()])
  expect(main.getSnapshot().settings).toMatchObject({ editor: "Editor", editorPath: preferred.path })
  expect(status.getSnapshot().settings).toEqual(main.getSnapshot().settings)
  const legacy = createMemorySettingsStore({ editor: "Saved Editor" })
  await createApplicationService(legacy).read()
  expect(legacy.getSnapshot().settings).toMatchObject({ editor: "Saved Editor", editorPath: null })
})

it("follows changed native defaults in both windows when no application or mode was saved", async () => {
  const persisted = persistedSettings({ notifyActions: false })
  const main = createSettingsStore(persisted.backend)
  const status = createSettingsStore(persisted.backend)
  await Promise.all([main.initialize(), status.initialize()])
  const savedBytes = persisted.bytes()
  native.invoke.mockResolvedValue(catalog)
  await Promise.all([createApplicationService(main).read(), createApplicationService(status).read()])
  for (const kind of kinds) {
    expect(main.getSnapshot().settings).toMatchObject({
      [kind]: catalog[kind][0].name, [`${kind}Path`]: catalog[kind][0].path, [`${kind}UseSystemDefault`]: true,
    })
  }
  const nextTerminal = { name: "Kitty", path: "/Applications/kitty.app" }
  const nextEditor = { name: "Code", path: "/Applications/Visual Studio Code.app" }
  const nextBrowser = { name: "Chromium", path: "/Applications/Chromium.app" }
  const next = {
    ...catalog,
    terminal: [terminal, nextTerminal], editor: [editor, nextEditor], browser: [browser, nextBrowser],
    defaults: { terminal: nextTerminal.path, editor: nextEditor.path, browser: nextBrowser.path },
  }
  native.invoke.mockResolvedValue(next)
  await Promise.all([main.refresh(), status.refresh()])
  await Promise.all([createApplicationService(main).read(), createApplicationService(status).read()])
  for (const kind of kinds) {
    expect(main.getSnapshot().settings).toMatchObject({
      [kind]: next[kind][1].name, [`${kind}Path`]: next[kind][1].path, [`${kind}UseSystemDefault`]: true,
    })
  }
  expect(status.getSnapshot().settings).toEqual(main.getSnapshot().settings)
  expect(persisted.bytes()).toBe(savedBytes)
  expect(persisted.backend.updateSettings).not.toHaveBeenCalled()
  main.dispose()
  status.dispose()
})

it.each(kinds)("keeps legacy %s labels and paths explicit unless system mode is enabled", async (kind) => {
  native.invoke.mockResolvedValue(catalog)
  for (const saved of [
    { [kind]: "Saved application" },
    { [`${kind}Path`]: "/Applications/Custom.app" },
    { [kind]: "Saved application", [`${kind}Path`]: "/Applications/Custom.app", [`${kind}UseSystemDefault`]: false },
  ]) {
    const persisted = persistedSettings(saved)
    const store = createSettingsStore(persisted.backend)
    await store.initialize()
    const savedBytes = persisted.bytes()
    const service = createApplicationService(store)
    await service.read()
    await store.refresh()
    await service.read()
    expect(store.getSnapshot().settings).toMatchObject({ ...saved, [`${kind}UseSystemDefault`]: false })
    if (!(`${kind}Path` in saved)) expect(store.getSnapshot().settings[`${kind}Path`]).toBeNull()
    expect(persisted.bytes()).toBe(savedBytes)
    expect(persisted.backend.updateSettings).not.toHaveBeenCalled()
    store.dispose()
  }
})

it.each(kinds)("switches legacy %s to live system defaults across refresh and remount without erasing its saved choice", async (kind) => {
  const saved = { [kind]: "Custom label", [`${kind}Path`]: "/Users/example/Applications/Custom.app" }
  const persisted = persistedSettings(saved)
  const main = createSettingsStore(persisted.backend)
  const status = createSettingsStore(persisted.backend)
  await Promise.all([main.initialize(), status.initialize()])
  native.invoke.mockResolvedValue(catalog)
  await Promise.all([createApplicationService(main).read(), createApplicationService(status).read()])
  expect(main.getSnapshot().settings).toMatchObject({ ...saved, [`${kind}UseSystemDefault`]: false })

  await main.updateSettings({ [`${kind}UseSystemDefault`]: true })
  const savedBytes = persisted.bytes()
  expect(JSON.parse(savedBytes).settings).toEqual({ ...saved, [`${kind}UseSystemDefault`]: true })
  for (const store of [main, status]) {
    expect(store.getSnapshot().settings).toMatchObject({
      [kind]: catalog[kind][0].name, [`${kind}Path`]: catalog[kind][0].path, [`${kind}UseSystemDefault`]: true,
    })
  }

  const changedDefault = { name: "New default", path: "/Applications/New Default.app" }
  native.invoke.mockResolvedValue({
    ...catalog, [kind]: [...catalog[kind], changedDefault], defaults: { ...catalog.defaults, [kind]: changedDefault.path },
  })
  await Promise.all([main.refresh(), status.refresh()])
  await Promise.all([createApplicationService(main).read(), createApplicationService(status).read()])
  main.dispose()
  const remounted = createSettingsStore(persisted.backend)
  await remounted.initialize()
  await createApplicationService(remounted).read()
  for (const store of [status, remounted]) {
    expect(store.getSnapshot().settings).toMatchObject({
      [kind]: changedDefault.name, [`${kind}Path`]: changedDefault.path, [`${kind}UseSystemDefault`]: true,
    })
  }
  expect(persisted.bytes()).toBe(savedBytes)
  expect(persisted.backend.updateSettings).toHaveBeenCalledExactlyOnceWith({ [`${kind}UseSystemDefault`]: true })

  await remounted.updateSettings({ [`${kind}UseSystemDefault`]: false })
  for (const store of [status, remounted]) {
    expect(store.getSnapshot().settings).toMatchObject({ ...saved, [`${kind}UseSystemDefault`]: false })
  }
  status.dispose()
  remounted.dispose()
})

it("keeps the exact chosen location and treats cancellation as no choice", async () => {
  const service = createApplicationService(createMemorySettingsStore())
  const chosen = { name: "Custom", path: "/Users/example/Applications/Custom.app" }
  native.invoke.mockResolvedValueOnce(chosen).mockResolvedValueOnce(null)
  expect(await service.choose("editor")).toEqual(chosen)
  expect(native.invoke).toHaveBeenCalledWith("choose_application", { kind: "editor" })
  expect(await service.choose("editor")).toBeNull()
})

it("rejects invalid native choices and leaves preferences intact after discovery failure", async () => {
  const store = createMemorySettingsStore({ editor: "Saved", editorPath: "/Applications/Saved.app" })
  const service = createApplicationService(store)
  native.invoke.mockResolvedValueOnce({ name: "Invalid", path: "relative.app" })
  await expect(service.choose("editor")).rejects.toThrow()
  native.invoke.mockRejectedValueOnce(new Error("Discovery unavailable"))
  await expect(service.read()).rejects.toThrow("Discovery unavailable")
  expect(store.getSnapshot().settings).toMatchObject({ editor: "Saved", editorPath: "/Applications/Saved.app" })
})
