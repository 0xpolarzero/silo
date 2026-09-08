import type { ApplicationSource, ApplicationWorkspace } from "./application-source"

export function workspaceAvailability(workspace: ApplicationWorkspace, source: ApplicationSource) {
  const repair = source.runtimeRepair
  const busy = workspace.state === "starting" || source.activities.some((activity) => activity.category === "sandbox" && activity.workspace === workspace.machine.name && activity.status === "running")
  const blocked = Boolean(repair || source.sandboxConfigurationOperation || busy || workspace.freshness === "stale" || workspace.attention?.level === "error")
  return {
    busy,
    canOpen: !blocked && workspace.state === "running",
    canStart: !blocked && workspace.state === "stopped",
    canStop: !blocked && workspace.state === "running",
    canRestart: !blocked && workspace.state === "running",
  }
}
