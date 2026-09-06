import type { ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"

export function statusBarHealth(source: ApplicationSource) {
  const repair = source.runtimeRepair
  if (repair && repair.status !== "succeeded") {
    return { label: repair.status === "repairing" ? "Repairing…" : "Needs repair", tone: repair.status === "repairing" ? "busy" : "error" } as const
  }
  if (source.workspaces.some((workspace) => workspace.state === "failed" || workspace.attention?.level === "error")
    || source.sandboxConfigurationOperation?.status === "failed"
    || source.repositoryPushOperations.some(({ status }) => status === "failed")) {
    return { label: "Needs attention", tone: "error" } as const
  }
  if (source.workspaces.some(({ freshness }) => freshness === "stale")) return { label: "Last known status", tone: "warning" } as const
  if (source.workspaces.some(({ attention }) => attention?.level === "warning")) return { label: "Needs attention", tone: "warning" } as const
  if (source.workspaces.some(({ state }) => state === "starting")
    || source.sandboxConfigurationOperation?.status === "applying"
    || source.activities.some(({ status }) => status === "running")) return { label: "Working…", tone: "busy" } as const
  if (source.workspaces.length === 0) return { label: "No sandboxes", tone: "neutral" } as const
  return { label: "Ready", tone: "success" } as const
}

export function statusWorkspaceAvailability(workspace: ApplicationWorkspace, source: ApplicationSource) {
  const repair = source.runtimeRepair && source.runtimeRepair.status !== "succeeded"
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
