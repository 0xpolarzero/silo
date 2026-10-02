import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { ProductionSurface } from "./production-surface"
import type { ReactNode } from "react"

vi.mock("./runtime-migration-boundary", () => ({ RuntimeMigrationBoundary: ({ children }: { children: ReactNode }) => children }))
import { createMemorySettingsStore, createSettingsStore, SettingsProvider, type SettingsSnapshot } from "@/features/preferences/settings-store"
import type { ProductionSource } from "./production-source"
import { useUpdates } from "@/features/updates/update-store"

const backend = vi.hoisted(() => ({ read: vi.fn(), subscribe: vi.fn(), install: vi.fn() }))
vi.mock("./updates", () => ({ desktopUpdateBackend: backend }))
vi.mock("./use-main-route", () => ({ useMainRoute: () => undefined }))
vi.mock("./production-source", () => ({ useProductionSource: () => ({ source: {}, backup: {}, loading: false }) }))
vi.mock("./dependencies", () => ({ useDependencyStore: () => null }))
vi.mock("./status-panel", () => ({ StatusPanel: () => <div>Status panel</div> }))
vi.mock("@/features/application/application-app", () => ({ ApplicationApp: () => {
  const updates = useUpdates()
  return <><button disabled={!updates?.snapshot} onClick={() => updates?.install(false)}>Install test update</button>{updates?.connectionError && <p role="alert">{updates.connectionError}</p>}</>
} }))
const source = { applicationActions: {}, statusActions: {} } as unknown as ProductionSource
beforeEach(() => {
  vi.resetAllMocks()
  backend.read.mockResolvedValue({ phase: "ready" })
  backend.subscribe.mockResolvedValue(() => {})
  backend.install.mockResolvedValue({ phase: "installing" })
})
it("flushes pending frontend settings before requesting native installation", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore({ onboardingComplete: true })
  const order: string[] = []
  vi.spyOn(store, "flush").mockImplementation(async () => { order.push("flush") })
  backend.install.mockImplementation(async () => { order.push("install"); return { phase: "installing" } })
  render(<SettingsProvider store={store}><ProductionSurface source={source} dependencyStore={null} /></SettingsProvider>)
  await user.click(await screen.findByRole("button", { name: "Install test update" }))
  expect(order).toEqual(["flush", "install"])
  expect(backend.install).toHaveBeenCalledWith(false)
})
it("does not install if pending settings cannot be saved", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore({ onboardingComplete: true })
  vi.spyOn(store, "flush").mockRejectedValue(new Error("disk full"))
  render(<SettingsProvider store={store}><ProductionSurface source={source} dependencyStore={null} /></SettingsProvider>)
  await user.click(await screen.findByRole("button", { name: "Install test update" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("The update action could not finish")
  expect(backend.install).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Install test update" }).closest("[inert]")).toBeNull()
  expect(screen.queryByText("Preparing update…")).not.toBeInTheDocument()
})
it.each(["preferences", "onboarding draft"] as const)("keeps undelivered %s and installs once after delivery recovers", async (kind) => {
  const user = userEvent.setup()
  const errors = vi.spyOn(console, "error").mockImplementation(() => {})
  let saved: SettingsSnapshot = { revision: 0, settings: { onboardingComplete: true, theme: "light" }, onboardingDraft: null, saveError: null }
  let deliveryFails = true
  const deliver = async (change: Partial<SettingsSnapshot>) => {
    if (deliveryFails) throw new Error("settings delivery failed")
    saved = { ...saved, ...change, revision: saved.revision + 1 }
    return saved
  }
  const nativeFlush = vi.fn(async () => {})
  const store = createSettingsStore({
    read: async () => saved,
    subscribe: async () => () => {},
    updateSettings: (patch) => deliver({ settings: { ...saved.settings, ...patch } }),
    updateOnboardingDraft: (draft) => deliver({ onboardingDraft: draft }),
    flush: nativeFlush,
  }, {}, saved)
  const draft = { currentStep: "dependencies" as const, machines: [], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: {} }
  if (kind === "preferences") await store.updateSettings({ theme: "dark" })
  else await store.updateOnboardingDraft(draft)
  render(<SettingsProvider store={store}><ProductionSurface source={source} dependencyStore={null} /></SettingsProvider>)
  const install = await screen.findByRole("button", { name: "Install test update" })
  await user.click(install)
  expect(backend.install).not.toHaveBeenCalled()
  expect(errors.mock.calls).toEqual([["Silo settings:", "settings delivery failed"], ["Silo settings:", "settings delivery failed"]])
  errors.mockRestore()
  expect(await screen.findByRole("alert")).toHaveTextContent("The update action could not finish")
  expect(store.getSnapshot().saveError).toBe("settings delivery failed")
  expect(install.closest("[inert]")).toBeNull()
  if (kind === "preferences") {
    expect(store.getSnapshot().settings.theme).toBe("dark")
    expect(saved.settings.theme).toBe("light")
  } else {
    expect(store.getSnapshot().onboardingDraft).toEqual(draft)
    expect(saved.onboardingDraft).toBeNull()
  }
  deliveryFails = false
  backend.install.mockImplementation(async () => {
    expect(nativeFlush).toHaveBeenCalledOnce()
    expect(store.getSnapshot().saveError).toBeNull()
    if (kind === "preferences") expect(saved.settings.theme).toBe("dark")
    else expect(saved.onboardingDraft).toEqual(draft)
    return { phase: "installing" }
  })
  await user.click(install)
  expect(backend.install).toHaveBeenCalledExactlyOnceWith(false)
})
it("does not install with write-protected settings", async () => {
  const user = userEvent.setup()
  const saved: SettingsSnapshot = { revision: 0, settings: { onboardingComplete: true }, onboardingDraft: null, saveError: "settings file is protected", writeProtected: true }
  const store = createSettingsStore({
    read: async () => saved, subscribe: async () => () => {},
    updateSettings: async () => saved, updateOnboardingDraft: async () => saved, flush: async () => {},
  }, {}, saved)
  render(<SettingsProvider store={store}><ProductionSurface source={source} dependencyStore={null} /></SettingsProvider>)
  await user.click(await screen.findByRole("button", { name: "Install test update" }))
  expect(backend.install).not.toHaveBeenCalled()
  expect(await screen.findByRole("alert")).toHaveTextContent("The update action could not finish")
})
it("blocks edits before flushing and keeps them blocked through native installation", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore({ onboardingComplete: true })
  let finishFlush!: () => void
  vi.spyOn(store, "flush").mockReturnValue(new Promise<void>(resolve => { finishFlush = resolve }))
  render(<SettingsProvider store={store}><ProductionSurface source={source} dependencyStore={null} /></SettingsProvider>)
  const install = await screen.findByRole("button", { name: "Install test update" })
  await user.click(install)
  expect(install.closest("[inert]")).not.toBeNull()
  expect(screen.getByRole("status")).toHaveTextContent("Preparing update…")
  expect(screen.getByRole("status").closest("[inert]")).toBeNull()
  expect(backend.install).not.toHaveBeenCalled()
  await act(async () => finishFlush())
  expect(install.closest("[inert]")).not.toBeNull()
  expect(screen.getByRole("status")).toHaveTextContent("Installing update. Silo will restart…")
  expect(backend.subscribe).toHaveBeenCalledOnce()
})
it("restores editing when native installation fails", async () => {
  const user = userEvent.setup()
  backend.install.mockResolvedValue({ phase: "error", error: "Installation failed", retryAction: "install" })
  render(<SettingsProvider store={createMemorySettingsStore({ onboardingComplete: true })}><ProductionSurface source={source} dependencyStore={null} /></SettingsProvider>)
  const install = await screen.findByRole("button", { name: "Install test update" })
  await user.click(install)
  expect(backend.install).toHaveBeenCalledOnce()
  expect(install.closest("[inert]")).toBeNull()
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
})
it("does not start another update connection in the status panel", () => {
  render(<SettingsProvider store={createMemorySettingsStore({ onboardingComplete: true })}><ProductionSurface source={source} dependencyStore={null} statusPanel /></SettingsProvider>)
  expect(screen.getByText("Status panel")).toBeVisible()
  expect(backend.read).not.toHaveBeenCalled()
})
it("shows Debian package progress outside the installation guard", async () => {
  const user = userEvent.setup()
  backend.install.mockResolvedValue({ phase: "installing", installStatus: "Refreshing Silo’s package list…" })
  render(<SettingsProvider store={createMemorySettingsStore({ onboardingComplete: true })}><ProductionSurface source={source} dependencyStore={null} /></SettingsProvider>)
  const install = await screen.findByRole("button", { name: "Install test update" })
  await user.click(install)
  const progress = screen.getByRole("status")
  expect(progress).toHaveTextContent("Refreshing Silo’s package list…")
  expect(progress.closest("[inert]")).toBeNull()
  expect(install.closest("[inert]")).not.toBeNull()
})
