import { workspaceTarget } from "./remote-computers"
import type { ApplicationSource, ApplicationWorkspace } from "./application-source"

export interface WorkspaceAvailability {
  /** Work is running on the sandbox (or its computer); the row shows progress. */
  busy: boolean
  canOpen: boolean
  canStart: boolean
  canStop: boolean
  canRestart: boolean
  /** Why each unavailable control is disabled, for its tooltip. */
  reasons: { open?: string; start?: string; stop?: string; restart?: string }
}

const lifecycleProgress = { start: "starting", stop: "stopping", restart: "restarting", "dismiss-error": "clearing its error" } as const

/** Why nothing can be done with the sandbox right now, or undefined when it is free. */
function blockedReason(workspace: ApplicationWorkspace, source: ApplicationSource): string | undefined {
  const { computer, machine } = workspace
  if (!computer && source.runtimeRepair) return "Resolve the system issue first."
  if (!computer && source.sandboxConfigurationOperation) {
    return source.sandboxConfigurationOperation.status === "failed" ? "Dismiss the sandbox changes error first." : "Wait for sandbox changes to finish."
  }
  if (workspace.lifecycleAction) return `${machine.name} is ${lifecycleProgress[workspace.lifecycleAction]}.`
  if (workspace.checkpointOperation?.status === "running") return "Wait for the checkpoint to finish."
  if (workspace.accountMigration?.status === "running") return `Wait for ${machine.name} to finish moving to the silo account.`
  if (computer?.busy) return `${computer.name} is updating. Wait before changing this sandbox.`
  if (workspace.state === "starting") return `Wait for ${machine.name} to finish ${workspace.stateDetail === "Stopping" ? "stopping" : "starting"}.`
  if (source.activities.some((activity) => activity.category === "sandbox" && activity.workspace === workspaceTarget(workspace) && activity.status === "running")) return "Wait for the current operation to finish."
  if (workspace.freshness === "stale") return computer && !computer.connected ? `${computer.name} is offline. Reconnect it to manage this sandbox.` : "Silo could not refresh this sandbox’s status."
  return undefined
}

/**
 * The one availability rule for a sandbox's Open and lifecycle controls, shared by the
 * Sandboxes list, the sandbox page, the command palette and the status panel. A running
 * sandbox can be stopped or restarted; a stopped or crashed one started; a crashed one also
 * restarted (its documented recovery). An error notice blocks only opening the sandbox.
 */
export function workspaceAvailability(workspace: ApplicationWorkspace, source: ApplicationSource): WorkspaceAvailability {
  const { state, machine } = workspace
  const busy = Boolean(workspace.computer?.busy) || Boolean(workspace.lifecycleAction) || workspace.checkpointOperation?.status === "running" || workspace.accountMigration?.status === "running" || state === "starting"
    || source.activities.some((activity) => activity.category === "sandbox" && activity.workspace === workspaceTarget(workspace) && activity.status === "running")
  const blocked = blockedReason(workspace, source)
  const error = workspace.attention?.level === "error" ? workspace.attention.message : undefined
  // Silo opens and starts only sandboxes that use the silo account; stopping stays possible.
  const migrate = workspace.accountMigration ? accountMigrationReason(workspace) : undefined
  const canOpen = !blocked && !error && !migrate && state === "running"
  const canStart = !blocked && !migrate && (state === "stopped" || state === "failed")
  const canStop = !blocked && state === "running"
  const canRestart = !blocked && !migrate && (state === "running" || state === "failed")
  const reasons: WorkspaceAvailability["reasons"] = {}
  if (!canOpen) reasons.open = blocked ?? error ?? migrate ?? `Start ${machine.name} to open it.`
  if (!canStart) reasons.start = blocked ?? migrate ?? `${machine.name} is already running.`
  if (!canStop) reasons.stop = blocked ?? `${machine.name} isn’t running.`
  if (!canRestart) reasons.restart = blocked ?? migrate ?? `${machine.name} isn’t running.`
  return { busy, canOpen, canStart, canStop, canRestart, reasons }
}

/** Why a sandbox on the old account layout cannot be started or opened yet. */
export function accountMigrationReason(workspace: ApplicationWorkspace): string {
  return workspace.accountMigration?.status === "failed"
    ? `The migration of ${workspace.machine.name} to the silo account did not finish. Retry it first.`
    : `Migrate ${workspace.machine.name} to the silo account first.`
}
