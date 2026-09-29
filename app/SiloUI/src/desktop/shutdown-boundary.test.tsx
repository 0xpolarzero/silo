import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { ShutdownBoundary } from "./shutdown-boundary"

const native = vi.hoisted(() => ({ receive: vi.fn<(event: { payload: boolean }) => void>(), invoke: vi.fn(), stop: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
// Bind `native.receive` to the shutdown-state listener specifically: the boundary also
// subscribes to the operation queue while quitting, and that second listener must not
// steal the handle the tests use to toggle shutdown.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event: string, receive: typeof native.receive) => { if (event === "silo://shutdown-state-changed") native.receive = receive; return native.stop }) }))
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
  // While quitting the boundary holds two subscriptions: shutdown state and the
  // operation queue it reads for the overlay. Both are released on unmount.
  expect(native.stop).toHaveBeenCalledTimes(2)
})
it("names the running work Quit waits for and cancels only cancellable entries on request", async () => {
  const queue = { running: [
    { id: 7, label: "Stopping local VMs", kind: "shutdown", vmId: null, vmName: null, sinceMs: 0, cancellable: false, expectedMs: null, blockedByHidden: false },
    { id: 8, label: "Backing up sandboxes", vmId: null, vmName: null, sinceMs: 0, cancellable: true, expectedMs: null, blockedByHidden: false },
  ], waiting: [] }
  native.invoke.mockImplementation(async (name: string) => name === "read_operation_queue" ? queue : name === "read_shutdown_state" ? false : true)
  render(<ShutdownBoundary><button>Create VM</button></ShutdownBoundary>)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("read_shutdown_state"))
  act(() => native.receive({ payload: true }))
  expect(await screen.findByText("Waiting for Backing up sandboxes…")).toBeVisible()
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel and quit" }))
  expect(native.invoke).toHaveBeenCalledWith("cancel_operation", { id: 8 })
  expect(native.invoke).not.toHaveBeenCalledWith("cancel_operation", { id: 7 })
})
it("names the local sandbox Quit is stopping", async () => {
  const queue = { running: [{ id: 7, label: "Stopping dev (1 of 2)", kind: "shutdown", vmId: null, vmName: null, sinceMs: 0, cancellable: false, expectedMs: null, blockedByHidden: false }], waiting: [] }
  native.invoke.mockImplementation(async (name: string) => name === "read_operation_queue" ? queue : name === "read_shutdown_state" ? false : true)
  render(<ShutdownBoundary><button>Create VM</button></ShutdownBoundary>)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("read_shutdown_state"))
  act(() => native.receive({ payload: true }))
  expect(await screen.findByText("Stopping dev (1 of 2)…")).toBeVisible()
  expect(screen.queryByRole("button", { name: "Cancel and quit" })).not.toBeInTheDocument()
})
it("waits for non-cancellable running work and offers no cancel control", async () => {
  const queue = { running: [{ id: 9, label: "Installing update", vmId: null, vmName: null, sinceMs: 0, cancellable: false, expectedMs: null, blockedByHidden: false }], waiting: [] }
  native.invoke.mockImplementation(async (name: string) => name === "read_operation_queue" ? queue : name === "read_shutdown_state" ? false : true)
  render(<ShutdownBoundary><button>Create VM</button></ShutdownBoundary>)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("read_shutdown_state"))
  act(() => native.receive({ payload: true }))
  expect(await screen.findByText("Waiting for Installing update…")).toBeVisible()
  expect(screen.queryByRole("button", { name: "Cancel and quit" })).not.toBeInTheDocument()
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
