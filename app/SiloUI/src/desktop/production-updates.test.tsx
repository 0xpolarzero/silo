import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { ProductionSurface } from "./production-surface"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
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
})
it("does not start another update connection in the status panel", () => {
  render(<SettingsProvider store={createMemorySettingsStore({ onboardingComplete: true })}><ProductionSurface source={source} dependencyStore={null} statusPanel /></SettingsProvider>)
  expect(screen.getByText("Status panel")).toBeVisible()
  expect(backend.read).not.toHaveBeenCalled()
})
