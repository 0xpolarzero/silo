import type { ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"
import { cancelledActionLabel } from "@/features/application/model/operation-queue"
import { parseRemoteWorkspaceTarget, workspaceTarget } from "@/features/application/model/connections"

/**
 * A user-facing name for an operation's sandbox target. Remote targets are internal
 * (`silo-remote:<host>:<vm>`), so they resolve to "{sandbox} on {device}"; a remote
 * sandbox that is no longer listed still names its device.
 */
export function sandboxTargetLabel(target: string, source: Pick<ApplicationSource, "workspaces" | "devices">): string {
  const workspace = source.workspaces.find((candidate) => workspaceTarget(candidate) === target)
  if (workspace) return workspace.device ? `${workspace.machine.name} on ${workspace.device.name}` : workspace.machine.name
  let remote: ReturnType<typeof parseRemoteWorkspaceTarget>
  try { remote = parseRemoteWorkspaceTarget(target) } catch { return "a remote sandbox" }
  if (!remote) return target
  const deviceId = remote.deviceId
  const device = source.devices?.find(({ id }) => id === deviceId)
  return device ? `a sandbox on ${device.name}` : "a remote sandbox"
}

/**
 * The outcome of a sandbox's last lifecycle action when it did not succeed: a failure (an
 * error, even though the sandbox may simply read "Stopped") or a user cancellation (neutral).
 */
export function lifecycleOutcome(workspace: ApplicationWorkspace): { error: boolean; text: string } | undefined {
  if (!workspace.lifecycleFailure) return undefined
  const action = workspace.lifecycleFailureAction ?? "start"
  if (workspace.lifecycleFailureCancelled) return { error: false, text: cancelledActionLabel(action) }
  const verb = action === "restart" ? "Restart" : action === "stop" ? "Stop" : action === "dismiss-error" ? "Dismiss" : "Start"
  return { error: true, text: `${verb} failed · ${workspace.lifecycleFailure}` }
}

export function statusBarHealth(source: ApplicationSource) {
  const repair = source.runtimeRepair
  if (repair) return { label: "System issue", tone: "error" } as const
  if (source.workspaces.some((workspace) => workspace.state === "failed" || workspace.attention?.level === "error" || lifecycleOutcome(workspace)?.error)
    || source.sandboxConfigurationOperation?.status === "failed"
    || source.repositoryPushOperations.some(({ status }) => status === "failed")) {
    return { label: "Sandbox error", tone: "error" } as const
  }
  if (source.repositoryPushOperations.some(({ status }) => status === "unknown")) return { label: "Check push result", tone: "warning" } as const
  if (source.workspaces.some(({ freshness }) => freshness === "stale")) return { label: "Last known status", tone: "warning" } as const
  if (source.workspaces.some(({ attention }) => attention?.level === "warning")) return { label: "Sandbox warning", tone: "warning" } as const
  if (source.sandboxConfigurationOperation?.status === "awaiting-approval") return { label: "Approval needed", tone: "warning" } as const
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
