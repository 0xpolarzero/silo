import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { NativeLinuxDesktopViewer } from "./linux-desktop-viewer"

const invoke = vi.hoisted(() => vi.fn())
const nativeMenu = vi.hoisted(() => ({ create: vi.fn(), popup: vi.fn(), close: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: nativeMenu.create } }))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: vi.fn(), innerSize: async () => ({ height: (window.innerHeight + 32) * 2 }), scaleFactor: async () => 2 }) }))
let resize: (() => void) | undefined
beforeEach(() => {
  invoke.mockReset()
  nativeMenu.create.mockReset().mockResolvedValue({ popup: nativeMenu.popup, close: nativeMenu.close })
  nativeMenu.popup.mockReset().mockResolvedValue(undefined)
  nativeMenu.close.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 44, left: 0, bottom: 644, width: 1000, height: 600 } as DOMRect)
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

it("repairs a confirmed remote tool failure without starting a stopped desktop", async () => {
  invoke.mockImplementation(async command => command === "read_desktop_state" ? { installed: true, autoStart: false, state: "stopped", ludaState: "failed" }
    : command === "desktop_action" ? { installed: true, autoStart: false, state: "stopped", ludaState: "ready", ludaVersion: "0.3.0" } : undefined)
  const user = userEvent.setup()
  render(<NativeLinuxDesktopViewer workspace="owner/vm-id" name="dev · Remote" />)
  await screen.findByRole("button", { name: "Repair agent tools" })
  expect(invoke.mock.calls.some(([command]) => command === "desktop_action")).toBe(false)
  await user.click(screen.getByRole("button", { name: "Repair agent tools" }))
  await screen.findByText(/Reconnect agent sessions/)
  expect(screen.queryByRole("button", { name: /agent tools/ })).not.toBeInTheDocument()
  expect(invoke).toHaveBeenCalledWith("desktop_action", { workspace: "owner/vm-id", action: "setup-tools" })
  expect(invoke.mock.calls.some(([command]) => command === "desktop_viewer_attach")).toBe(false)
  expect(screen.getByRole("button", { name: "Start desktop" })).toBeVisible()
})

it("uses a native dropdown without reconnecting or resizing the guest", async () => {
  invoke.mockImplementation(async command => command === "read_desktop_state" ? { installed: true, autoStart: true, state: "running", ludaState: "ready" } : undefined)
  const user = userEvent.setup()
  const view = render(<NativeLinuxDesktopViewer workspace="dev" name="dev" />)
  await screen.findByRole("button", { name: "Desktop actions" })
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("desktop_viewer_attach", expect.anything()))
  invoke.mockClear()
  await user.click(screen.getByRole("button", { name: "Desktop actions" }))
  expect(nativeMenu.popup).toHaveBeenCalledOnce()
  expect(nativeMenu.popup).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 676 }))
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(invoke).not.toHaveBeenCalled()
  // GTK returns before dismissal, so the menu must survive popup resolution.
  expect(nativeMenu.close).not.toHaveBeenCalled()
  const items = nativeMenu.create.mock.calls[0][0].items
  expect(items.map((item: { text: string }) => item.text)).toEqual(["Restart desktop…", "Stop desktop…"])
  act(() => items[1].action())
  expect(invoke).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Stop desktop" }))
  expect(invoke).toHaveBeenCalledWith("desktop_action", { workspace: "dev", action: "stop" })
  view.unmount()
  expect(nativeMenu.close).toHaveBeenCalledOnce()
})

it("does not turn a guest status error into a Luda failure", async () => {
  invoke.mockImplementation(async command => {
    if (command === "read_desktop_state") throw new Error("Computer disconnected")
  })
  render(<NativeLinuxDesktopViewer workspace="owner/vm-id" name="dev · Remote" />)
  expect(await screen.findByRole("alert")).toHaveTextContent("Computer disconnected")
  expect(screen.queryByRole("button", { name: /agent tools/ })).not.toBeInTheDocument()
})
