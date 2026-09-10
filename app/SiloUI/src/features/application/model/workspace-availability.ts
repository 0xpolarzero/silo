import { workspaceTarget } from "./remote-computers"
import type { ApplicationSource, ApplicationWorkspace } from "./application-source"

export function workspaceAvailability(workspace: ApplicationWorkspace, source: ApplicationSource) {
  const repair = !workspace.computer && source.runtimeRepair
  const busy = Boolean(workspace.computer?.busy) || Boolean(workspace.lifecycleAction) || workspace.state === "starting" || source.activities.some((activity) => activity.category === "sandbox" && activity.workspace === workspaceTarget(workspace) && activity.status === "running")
  const blocked = Boolean(repair || (!workspace.computer && source.sandboxConfigurationOperation) || busy || workspace.freshness === "stale" || workspace.attention?.level === "error")
  return {
    busy,
    canOpen: !blocked && workspace.state === "running",
    canStart: !blocked && workspace.state === "stopped",
    canStop: !blocked && workspace.state === "running",
    canRestart: !blocked && workspace.state === "running",
  }
}
