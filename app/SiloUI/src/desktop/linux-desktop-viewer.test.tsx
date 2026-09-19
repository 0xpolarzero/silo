import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { LinuxDesktopViewer } from "./linux-desktop-viewer"
import type { LinuxDesktopState } from "./linux-desktop-state"

function viewer(state: LinuxDesktopState, error: string | null = null) {
  const onAction = vi.fn()
  const onRetry = vi.fn()
  render(<LinuxDesktopViewer name="dev · Build computer" state={state} busy={false} error={error} onAction={onAction} onRetry={onRetry} onFullscreen={vi.fn()} />)
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
    await user.click(screen.getByRole("button", { name: "Stop desktop" }))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("closes its graphical applications")
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
  it("does not offer agent control or installation inside the viewer", () => {
    viewer({ installed: false, autoStart: true, state: "uninstalled" })
    expect(screen.getByText("Add a desktop in the sandbox configuration.")).toBeVisible()
    expect(screen.queryByRole("button", { name: /Start desktop|agent|control/i })).not.toBeInTheDocument()
  })
})
