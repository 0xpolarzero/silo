import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { StatusBarActions } from "@/features/status-bar/status-bar-types"
import { StatusPanel } from "./status-panel"
import { createMemorySettingsStore, SettingsProvider, type SettingsStore } from "@/features/preferences/settings-store"

const native = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined), opened: () => {}, menu: vi.fn(), popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn((_name, callback) => { native.opened = callback; return Promise.resolve(vi.fn()) }) }))
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: native.menu } }))
beforeEach(() => {
  vi.clearAllMocks()
  native.menu.mockResolvedValue({ popup: native.popup, close: native.close })
})

function setup(store?: SettingsStore) {
  const actions: StatusBarActions = {
    openSilo: vi.fn(), quit: vi.fn(), refresh: vi.fn(), startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(), openTerminal: vi.fn(), openEditor: vi.fn(), openSite: vi.fn(), pushRepository: vi.fn(), dismissRepositoryPush: vi.fn(),
  }
  const panel = <StatusPanel source={applicationSourceForScenario("running")} actions={actions} />
  render(store ? <SettingsProvider store={store}>{panel}</SettingsProvider> : panel)
  return { actions, user: userEvent.setup() }
}

it("propagates resolved apps to shortcuts, native menus, and an already-open folder picker", async () => {
  const store = createMemorySettingsStore()
  store.updateDefaults({ editor: "Zed", editorPath: "/Applications/Zed.app", terminal: "Ghostty" })
  const { user } = setup(store)
  expect(screen.getByRole("button", { name: "Open dev in Ghostty" })).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  expect(native.menu.mock.calls[0][0].items).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "Open in Zed…" }),
    expect.objectContaining({ text: "Open in Ghostty" }),
  ]))
  await user.click(screen.getByRole("button", { name: "Open dev in Zed" }))
  expect(screen.getByRole("button", { name: "Open in Zed" })).toBeVisible()
  await act(async () => { await store.updateSettings({ editor: "Cursor", editorUseSystemDefault: false }) })
  expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeVisible()
  act(() => native.opened())
  expect(screen.getByRole("button", { name: "Open dev in Cursor" })).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  expect(native.menu.mock.lastCall![0].items).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "Open in Cursor…" }),
  ]))
})

it("uses the real quit command and keeps the existing status content", async () => {
  const { user, actions } = setup()
  expect(screen.getByRole("list", { name: "Sandboxes" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Silo status bar" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Quit Silo" }))
  expect(native.invoke).toHaveBeenCalledWith("quit_app")
  expect(actions.quit).not.toHaveBeenCalled()
})

it("uses an OS popup and retains stop confirmation in the panel", async () => {
  const { user, actions } = setup()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  expect(native.popup).toHaveBeenCalledOnce()
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  const items = native.menu.mock.calls[0][0].items
  act(() => items.find((item: { text: string }) => item.text === "Stop…").action())
  expect(actions.stopWorkspace).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Stop" }))
  expect(actions.stopWorkspace).toHaveBeenCalledWith("dev")
  expect(native.close).toHaveBeenCalledOnce()
})

it("routes a native site selection through panel dismissal", async () => {
  const { user, actions } = setup()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  const sites = native.menu.mock.calls[0][0].items.find((item: { text: string }) => item.text === "Open site")
  expect(sites.enabled).toBe(true)
  const port = sites.items.find((item: { text?: string }) => item.text?.startsWith("Port "))
  expect(port).toBeDefined()
  await act(async () => port.action())
  expect(native.invoke).toHaveBeenCalledWith("hide_status")
  expect(actions.openSite).toHaveBeenCalledWith("dev", Number(port.text.slice(5)))
})

it("reports native menu failure and allows retry", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  native.popup.mockRejectedValueOnce(new Error("Popup failed"))
  const { user } = setup()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  expect(screen.getByRole("status")).toHaveTextContent("Couldn't open sandbox actions")
  expect(native.close).toHaveBeenCalledOnce()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  expect(native.popup).toHaveBeenCalledTimes(2)
  error.mockRestore()
})

it("dismisses with Escape after native menu tracking ends", async () => {
  const { user } = setup()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  await user.keyboard("{Escape}")
  expect(native.invoke).toHaveBeenCalledWith("hide_status")
})

it("returns to sandbox rows when the status item is opened again", async () => {
  const { user } = setup()
  await user.click(screen.getByRole("button", { name: "Open dev in Visual Studio Code" }))
  expect(screen.queryByRole("button", { name: "Quit Silo" })).not.toBeInTheDocument()
  act(() => native.opened())
  expect(screen.getByRole("button", { name: "Quit Silo" })).toBeVisible()
})
