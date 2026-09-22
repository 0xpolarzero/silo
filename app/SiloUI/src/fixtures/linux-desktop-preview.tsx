import { useState } from "react"
import { LinuxDesktopViewer } from "@/desktop/linux-desktop-viewer"
import { linuxDesktopStateSchema, type LinuxDesktopState } from "@/desktop/linux-desktop-state"

export function LinuxDesktopPreview() {
  const parameters = new URLSearchParams(window.location.search)
  const parsed = linuxDesktopStateSchema.shape.state.safeParse(parameters.get("desktop-state"))
  const tools = linuxDesktopStateSchema.shape.ludaState.safeParse(parameters.get("desktop-tools") ?? "ready")
  const [state, setState] = useState<LinuxDesktopState>({ installed: true, autoStart: parameters.get("desktop-manual") !== "true", state: parsed.success ? parsed.data : "stopped", ludaState: tools.success ? tools.data : null })
  return <LinuxDesktopViewer name="dev · This computer (fixture)" state={state} busy={false} error={null}
    onAction={action => setState(current => (action === "setup-tools" ? { ...current, ludaState: "ready", ludaVersion: "0.3.4" } : { ...current, state: action === "stop" ? "stopped" : "running" }))}
    onRetry={() => {}}
    onFullscreen={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen() }} />
}
