import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { ShutdownBoundary } from "./shutdown-boundary"

const native = vi.hoisted(() => ({ receive: vi.fn<(event: { payload: boolean }) => void>(), invoke: vi.fn(), stop: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, receive: typeof native.receive) => { native.receive = receive; return native.stop }) }))
beforeEach(() => { vi.clearAllMocks(); native.invoke.mockResolvedValue(false) })

it("shows shutdown progress and disables the existing screen until native failure cancels Quit", async () => {
  const user = userEvent.setup()
  render(<ShutdownBoundary><input aria-label="Sandbox name" defaultValue="My sandbox" /><button>Create VM</button></ShutdownBoundary>)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("read_shutdown_state"))
  screen.getByRole("button", { name: "Create VM" }).focus()
  act(() => native.receive({ payload: true }))
  expect(screen.getByRole("dialog", { name: "Quitting Silo" })).toBeVisible()
  expect(screen.getByRole("status")).toHaveTextContent("Stopping local sandboxes…")
  expect(screen.getByText("Create VM").closest("[inert]")).not.toBeNull()
  await user.keyboard("{Escape}{Tab}{Enter}")
  expect(screen.getByRole("dialog", { name: "Quitting Silo" })).toHaveFocus()
  act(() => native.receive({ payload: false }))
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Create VM" }).closest("[inert]")).toBeNull()
  expect(screen.getByRole("textbox", { name: "Sandbox name" })).toHaveValue("My sandbox")
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Create VM" })).toHaveFocus())
})
it("reads active shutdown when a window opens after the event", async () => {
  native.invoke.mockResolvedValue(true)
  const view = render(<ShutdownBoundary compact><button>Quit Silo</button></ShutdownBoundary>)
  expect(await screen.findByRole("status")).toHaveTextContent("Stopping local sandboxes…")
  view.unmount()
  expect(native.stop).toHaveBeenCalledOnce()
})
it("does not let an older snapshot replace a newer shutdown event", async () => {
  let resolve!: (value: boolean) => void
  native.invoke.mockReturnValue(new Promise<boolean>(done => { resolve = done }))
  render(<ShutdownBoundary><button>Create VM</button></ShutdownBoundary>)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled())
  act(() => native.receive({ payload: true }))
  await act(async () => resolve(false))
  expect(screen.getByRole("status")).toBeVisible()
})
