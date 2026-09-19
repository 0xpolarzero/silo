import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { NativeLinuxDesktopViewer } from "./linux-desktop-viewer"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: vi.fn() }) }))
let resize: (() => void) | undefined
beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 44, width: 1000, height: 600 } as DOMRect)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("opens a stopped VM viewer without starting the VM and only starts after the user's action", async () => {
  invoke.mockImplementation(async command => command === "read_desktop_state" ? { installed: true, autoStart: false, state: "vm-stopped" }
    : command === "desktop_action" ? { installed: true, autoStart: false, state: "running" } : undefined)
  const user = userEvent.setup()
  render(<NativeLinuxDesktopViewer workspace="owner/vm-id" name="dev · Remote" />)
  await screen.findByRole("button", { name: "Start sandbox and desktop" })
  expect(invoke.mock.calls.some(([command]) => command === "desktop_action" || command === "desktop_viewer_attach")).toBe(false)
  await user.click(screen.getByRole("button", { name: "Start sandbox and desktop" }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("desktop_viewer_attach", { workspace: "owner/vm-id", x: 0, y: 44, width: 1000, height: 600, viewportHeight: window.innerHeight }))
  expect(invoke).toHaveBeenCalledWith("desktop_action", { workspace: "owner/vm-id", action: "start" })
})

it("resizes the native view and detaches on close without stopping its session", async () => {
  invoke.mockImplementation(async command => command === "read_desktop_state" ? { installed: true, autoStart: true, state: "running" } : undefined)
  const view = render(<NativeLinuxDesktopViewer workspace="dev" name="dev" />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("desktop_viewer_attach", expect.objectContaining({ workspace: "dev" })))
  invoke.mockClear()
  await act(async () => { resize?.() })
  expect(invoke).toHaveBeenCalledWith("desktop_viewer_attach", expect.objectContaining({ width: 1000, height: 600 }))
  view.unmount()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("desktop_viewer_detach"))
  expect(invoke.mock.calls.some(([command]) => command === "desktop_action")).toBe(false)
})

it("keeps a transport failure visible when subsequent guest health checks succeed", async () => {
  invoke.mockImplementation(async command => {
    if (command === "read_desktop_state") return { installed: true, autoStart: true, state: "running" }
    if (command === "desktop_viewer_attach") throw new Error("Desktop connection unavailable")
  })
  const user = userEvent.setup()
  render(<NativeLinuxDesktopViewer workspace="dev" name="dev" />)
  expect(await screen.findByRole("alert")).toHaveTextContent("Desktop connection unavailable")
  await user.click(screen.getByRole("button", { name: "Reconnect" }))
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "read_desktop_state").length).toBeGreaterThan(1))
  expect(screen.getByRole("alert")).toHaveTextContent("Desktop connection unavailable")
})


it("finishes an in-flight attachment before detaching on close", async () => {
  let completeAttachment: (() => void) | undefined
  invoke.mockImplementation(async command => {
    if (command === "read_desktop_state") return { installed: true, autoStart: true, state: "running" }
    if (command === "desktop_viewer_attach") await new Promise<void>(resolve => { completeAttachment = resolve })
  })
  const view = render(<NativeLinuxDesktopViewer workspace="dev" name="dev" />)
  await waitFor(() => expect(completeAttachment).toBeDefined())
  invoke.mockClear()
  // Resizes arriving during the pending attachment must not survive the close.
  act(() => { resize?.() })
  view.unmount()
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => { completeAttachment?.() })
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("desktop_viewer_detach"))
  expect(invoke.mock.calls.some(([command]) => command === "desktop_viewer_attach")).toBe(false)
})

it("reconnects by detaching the previous child before attaching a fresh one", async () => {
  let fail = true
  invoke.mockImplementation(async command => {
    if (command === "read_desktop_state") return { installed: true, autoStart: true, state: "running" }
    if (command === "desktop_viewer_attach" && fail) throw new Error("Connection lost")
  })
  const user = userEvent.setup()
  render(<NativeLinuxDesktopViewer workspace="dev" name="dev" />)
  await screen.findByRole("alert")
  invoke.mockClear()
  fail = false
  await user.click(screen.getByRole("button", { name: "Reconnect" }))
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
  expect(invoke.mock.calls.map(([command]) => command).filter(command => command.startsWith("desktop_viewer_"))).toEqual(["desktop_viewer_detach", "desktop_viewer_attach"])
})


it("updates the native inset when the viewport changes even if display bounds are unchanged", async () => {
  let viewportHeight = 788
  vi.spyOn(window, "innerHeight", "get").mockImplementation(() => viewportHeight)
  invoke.mockImplementation(async command => command === "read_desktop_state" ? { installed: true, autoStart: true, state: "running" } : undefined)
  const view = render(<NativeLinuxDesktopViewer workspace="dev" name="dev" />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("desktop_viewer_attach", expect.objectContaining({ viewportHeight: 788 })))
  invoke.mockClear()
  viewportHeight = 820
  await act(async () => { window.dispatchEvent(new Event("resize")) })
  expect(invoke).toHaveBeenCalledWith("desktop_viewer_attach", { workspace: "dev", x: 0, y: 44, width: 1000, height: 600, viewportHeight: 820 })
  view.unmount()
  await act(async () => { window.dispatchEvent(new Event("resize")) })
  expect(invoke.mock.calls.filter(([command]) => command === "desktop_viewer_attach")).toHaveLength(1)
})
