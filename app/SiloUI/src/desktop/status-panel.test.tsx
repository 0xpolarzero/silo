import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { StatusBarActions } from "@/features/status-bar/status-bar-types"
import { StatusPanel } from "./status-panel"

const native = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined), opened: () => {} }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn((_name, callback) => { native.opened = callback; return Promise.resolve(vi.fn()) }) }))
beforeEach(() => native.invoke.mockClear())

function setup() {
  const actions: StatusBarActions = {
    openSilo: vi.fn(), quit: vi.fn(), refresh: vi.fn(), startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(), openTerminal: vi.fn(), openEditor: vi.fn(), openSite: vi.fn(), pushRepository: vi.fn(), dismissRepositoryPush: vi.fn(),
  }
  render(<StatusPanel source={applicationSourceForScenario("running")} actions={actions} />)
  return { actions, user: userEvent.setup() }
}

it("uses the real quit command and keeps the existing status content", async () => {
  const { user, actions } = setup()
  expect(screen.getByRole("list", { name: "Sandboxes" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Silo status bar" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Quit Silo" }))
  expect(native.invoke).toHaveBeenCalledWith("quit_app")
  expect(actions.quit).not.toHaveBeenCalled()
})

it("dismisses a nested menu before dismissing the native panel with Escape", async () => {
  const { user } = setup()
  await user.click(screen.getByRole("button", { name: "Actions for dev" }))
  await user.keyboard("{Escape}")
  expect(native.invoke).not.toHaveBeenCalledWith("hide_status")
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
