import { useState } from "react"
import { LinuxDesktopViewer } from "@/desktop/linux-desktop-viewer"
import { computerUseFixtureFromSearch, fixtureDesktopState } from "./computer-use"
import { linuxDesktopStateSchema, type LinuxDesktopState } from "@/desktop/linux-desktop-state"

export function LinuxDesktopPreview() {
  const parameters = new URLSearchParams(window.location.search)
  const parsed = linuxDesktopStateSchema.shape.state.safeParse(parameters.get("desktop-state"))
  const computerUse = computerUseFixtureFromSearch(window.location.search)
  const [state, setState] = useState<LinuxDesktopState>(computerUse ? fixtureDesktopState(computerUse) : { installed: true, autoStart: parameters.get("desktop-manual") !== "true", state: parsed.success ? parsed.data : "stopped" })
  return <LinuxDesktopViewer name="dev · This computer (fixture)" state={state} busy={false} error={null}
    onAction={action => setState(current => action === "setup-computer-use" && current.computerUse ? { ...current, computerUse: { ...current.computerUse, state: "ready", reason: null } } : { ...current, state: action === "stop" ? "stopped" : "running" })}
    onRetry={() => {}}
    onFullscreen={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen() }} />
}
