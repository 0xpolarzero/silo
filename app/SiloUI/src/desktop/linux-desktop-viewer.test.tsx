import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { LinuxDesktopViewer } from "./linux-desktop-viewer"
import type { LinuxDesktopState } from "./linux-desktop-state"

function viewer(state: LinuxDesktopState, error: string | null = null, busy = false) {
  const onAction = vi.fn()
  const onRetry = vi.fn()
  render(<LinuxDesktopViewer name="dev · Build computer" state={state} busy={busy} error={error} onAction={onAction} onRetry={onRetry} onFullscreen={vi.fn()} />)
  return { onAction, onRetry }
}

describe("desktop viewer lifecycle", () => {
  it.each([true, false])("requires an explicit action to start a stopped VM (automatic=%s)", async autoStart => {
    const user = userEvent.setup()
    const { onAction } = viewer({ installed: true, autoStart, state: "vm-stopped" })
    expect(onAction).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: autoStart ? "Start sandbox" : "Start sandbox and desktop" }))
    expect(onAction).toHaveBeenCalledWith("start")
  })
  it("starts a stopped session without changing startup preference", async () => {
    const user = userEvent.setup()
    const { onAction } = viewer({ installed: true, autoStart: false, state: "stopped" })
    await user.click(screen.getByRole("button", { name: "Start desktop" }))
    expect(onAction).toHaveBeenCalledWith("start")
  })
  it("requires confirmation before closing graphical applications", async () => {
    const user = userEvent.setup()
    const { onAction } = viewer({ installed: true, autoStart: true, state: "running" })
    await user.click(screen.getByRole("button", { name: "Desktop actions" }))
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Stop desktop" }))
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
    expect(within(screen.getByRole("banner")).getByRole("alert")).toHaveTextContent("closes its graphical applications")
    await user.click(screen.getByRole("button", { name: "Stop desktop" }))
    expect(onAction).toHaveBeenCalledWith("stop")
  })
  it("reconnects a failed view without restarting the desktop", async () => {
    const user = userEvent.setup()
    const { onAction, onRetry } = viewer({ installed: true, autoStart: true, state: "running" }, "Connection lost")
    await user.click(screen.getByRole("button", { name: "Reconnect" }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onAction).not.toHaveBeenCalled()
  })
  it.each(["missing", "failed"] as const)("offers repair in the existing header for confirmed %s tools", async ludaState => {
    const user = userEvent.setup()
    const { onAction } = viewer({ installed: true, autoStart: false, state: "running", ludaState })
    expect(onAction).not.toHaveBeenCalled()
    const header = within(screen.getByRole("banner"))
    expect(header.getByRole("alert")).toHaveTextContent("Agent tools unavailable")
    await user.click(header.getByRole("button", { name: "Repair agent tools" }))
    expect(onAction).toHaveBeenCalledExactlyOnceWith("setup-tools")
  })
  it.each(["ready", undefined, null] as const)("has no setup banner or repair action for %s tools", ludaState => {
    const { onAction } = viewer({ installed: true, autoStart: true, state: "running", ludaState })
    expect(screen.queryByText(/Agent desktop tools ready|Set up Luda/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /agent tools/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })
  it("does not diagnose tools while the VM is stopped", () => {
    viewer({ installed: true, autoStart: false, state: "vm-stopped", ludaState: "failed" })
    expect(screen.queryByRole("button", { name: /agent tools/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("shows installation progress without inviting another repair", () => {
    viewer({ installed: true, autoStart: false, state: "running", ludaState: "installing" }, null, true)
    expect(within(screen.getByRole("banner")).getByRole("status")).toHaveTextContent("Setting up agent tools")
    expect(screen.queryByRole("button", { name: /agent tools/ })).not.toBeInTheDocument()
  })
  it("closes the actions dropdown with Escape without changing the desktop", async () => {
    const user = userEvent.setup()
    const { onAction } = viewer({ installed: true, autoStart: true, state: "running" })
    const trigger = screen.getByRole("button", { name: "Desktop actions" })
    await user.click(trigger)
    expect(screen.getByRole("menuitem", { name: "Restart desktop" })).toBeVisible()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(onAction).not.toHaveBeenCalled()
  })
  it("does not offer agent control or installation inside the viewer", () => {
    viewer({ installed: false, autoStart: true, state: "uninstalled" })
    expect(screen.getByText("Add a desktop in the sandbox configuration.")).toBeVisible()
    expect(screen.queryByRole("button", { name: /Start desktop|agent|control/i })).not.toBeInTheDocument()
  })
})
