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
  it("ignores Luda fields still reported by an older guest", () => {
    viewer({ installed: true, autoStart: true, state: "running", ludaState: "failed" } as never)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/agent tools/i)).not.toBeInTheDocument()
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
  it("frames the guest display so sandbox content is never mistaken for Silo's", () => {
    viewer({ installed: true, autoStart: true, state: "running" })
    const frame = screen.getByRole("region", { name: "Sandbox display" })
    expect(frame).toHaveAccessibleDescription(/comes from the sandbox/)
    // The guest webview is placed on the inner element, never over the frame.
    const display = within(frame).getByLabelText("Linux desktop display")
    expect(display).not.toBe(frame)
    expect(frame).toHaveClass("p-1")
    expect(within(screen.getByRole("banner")).getByText("Sandbox content")).toHaveAttribute("title", expect.stringContaining("amber frame"))
  })
  it("shows no sandbox frame without a running desktop", () => {
    viewer({ installed: true, autoStart: true, state: "stopped" })
    expect(screen.queryByRole("region", { name: "Sandbox display" })).not.toBeInTheDocument()
    expect(screen.queryByText("Sandbox content")).not.toBeInTheDocument()
  })
  it("does not offer agent control or installation inside the viewer", () => {
    viewer({ installed: false, autoStart: true, state: "uninstalled" })
    expect(screen.getByText("Choose Add Linux desktop in the sandbox’s actions menu.")).toBeVisible()
    expect(screen.queryByRole("button", { name: /Start desktop|agent|control/i })).not.toBeInTheDocument()
  })
})
