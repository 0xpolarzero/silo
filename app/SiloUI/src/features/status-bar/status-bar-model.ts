import type { ApplicationSource } from "@/features/application/model/application-source"

export function statusBarHealth(source: ApplicationSource) {
  const repair = source.runtimeRepair
  if (repair && repair.status !== "succeeded" && repair.status !== "repairing") return { label: "Needs repair", tone: "error" } as const
  if (source.workspaces.some((workspace) => workspace.state === "failed" || workspace.attention?.level === "error")
    || source.sandboxConfigurationOperation?.status === "failed"
    || source.repositoryPushOperations.some(({ status }) => status === "failed")) {
    return { label: "Sandbox error", tone: "error" } as const
  }
  if (source.workspaces.some(({ freshness }) => freshness === "stale")) return { label: "Last known status", tone: "warning" } as const
  if (source.workspaces.some(({ attention }) => attention?.level === "warning")) return { label: "Sandbox warning", tone: "warning" } as const
  if (source.sandboxConfigurationOperation?.status === "awaiting-approval") return { label: "Approval needed", tone: "warning" } as const
  if (repair?.status === "repairing") return { label: "Repairing…", tone: "busy" } as const
  if (source.workspaces.some(({ state }) => state === "starting")
    || source.sandboxConfigurationOperation?.status === "applying"
    || source.repositoryPushOperations.some(({ status }) => status === "pushing")
    || source.github.state === "connecting"
    || source.github.workspaceOperations?.some(({ status }) => status === "applying")
    || source.activities.some(({ status }) => status === "running")) return { label: "Working…", tone: "busy" } as const
  if (source.workspaces.length === 0) return { label: "No sandboxes", tone: "neutral" } as const
  if (source.workspaces.every(({ state }) => state === "stopped")) return { label: "All sandboxes stopped", tone: "neutral" } as const
  return { label: "Ready", tone: "success" } as const
}
