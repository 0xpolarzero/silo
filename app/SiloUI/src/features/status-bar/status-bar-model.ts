import type { ApplicationSource, ApplicationComputer } from "@/features/application/model/application-source"
import { cancelledActionLabel } from "@/features/application/model/operation-queue"
import { parseRemoteComputerTarget, computerTarget } from "@/features/application/model/connections"

/**
 * A user-facing name for an operation's computer target. Remote targets are internal
 * (`silo-remote:<host>:<vm>`), so they resolve to "{computer} on {device}"; a remote
 * computer that is no longer listed still names its device.
 */
export function computerTargetLabel(target: string, source: Pick<ApplicationSource, "computers" | "devices">): string {
  const computer = source.computers.find((candidate) => computerTarget(candidate) === target)
  if (computer) return computer.device ? `${computer.configuration.name} on ${computer.device.name}` : computer.configuration.name
  let remote: ReturnType<typeof parseRemoteComputerTarget>
  try { remote = parseRemoteComputerTarget(target) } catch { return "a remote computer" }
  if (!remote) return target
  const deviceId = remote.deviceId
  const device = source.devices?.find(({ id }) => id === deviceId)
  return device ? `a computer on ${device.name}` : "a remote computer"
}

/**
 * The outcome of a computer's last lifecycle action when it did not succeed: a failure (an
 * error, even though the computer may simply read "Stopped") or a user cancellation (neutral).
 */
export function lifecycleOutcome(computer: ApplicationComputer): { error: boolean; text: string } | undefined {
  if (!computer.lifecycleFailure) return undefined
  const action = computer.lifecycleFailureAction ?? "start"
  if (computer.lifecycleFailureCancelled) return { error: false, text: cancelledActionLabel(action) }
  const verb = action === "restart" ? "Restart" : action === "stop" ? "Stop" : action === "dismiss-error" ? "Dismiss" : "Start"
  return { error: true, text: `${verb} failed · ${computer.lifecycleFailure}` }
}

export function statusBarHealth(source: ApplicationSource) {
  const repair = source.runtimeRepair
  if (repair) return { label: "System issue", tone: "error" } as const
  if (source.computers.some((computer) => computer.state === "failed" || computer.attention?.level === "error" || lifecycleOutcome(computer)?.error)
    || source.computerConfigurationOperation?.status === "failed"
    || source.repositoryPushOperations.some(({ status }) => status === "failed")) {
    return { label: "Computer error", tone: "error" } as const
  }
  if (source.repositoryPushOperations.some(({ status }) => status === "unknown")) return { label: "Check push result", tone: "warning" } as const
  if (source.computers.some(({ freshness }) => freshness === "stale")) return { label: "Last known status", tone: "warning" } as const
  if (source.computers.some(({ attention }) => attention?.level === "warning")) return { label: "Computer warning", tone: "warning" } as const
  if (source.computerConfigurationOperation?.status === "awaiting-approval") return { label: "Approval needed", tone: "warning" } as const
  if (source.computers.some(({ state }) => state === "starting")
    || source.computerConfigurationOperation?.status === "applying"
    || source.repositoryPushOperations.some(({ status }) => status === "pushing")
    || source.github.state === "connecting"
    || source.github.computerOperations?.some(({ status }) => status === "applying")
    || source.activities.some(({ status }) => status === "running")) return { label: "Working…", tone: "busy" } as const
  if (source.computers.length === 0) return { label: "No computers", tone: "neutral" } as const
  if (source.computers.every(({ state }) => state === "stopped")) return { label: "All computers stopped", tone: "neutral" } as const
  return { label: "Ready", tone: "success" } as const
}
