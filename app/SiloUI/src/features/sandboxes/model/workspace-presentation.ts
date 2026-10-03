import type { ApplicationWorkspace } from "@/features/application/model/application-source"
import type { SandboxIconState, SandboxRowTone } from "../components/sandbox-list"

export function workspaceIconState(workspace?: ApplicationWorkspace): SandboxIconState {
  if (workspace?.state === "failed") return "error"
  return workspace?.attention?.level ?? "normal"
}

/**
 * Why a sandbox cannot be edited or deleted right now. The runtime edits only running,
 * stopped or created VMs and deletes only stopped, created or crashed ones, so a VM that is
 * starting, stopping or restarting would be offered the action and then rejected.
 * A checkpoint also owns the sandbox until its operation finishes. Stale status cannot
 * establish whether a resource edit needs confirmation to stop the VM.
 */
export function sandboxBusyReason(workspace?: ApplicationWorkspace): string | undefined {
  if (!workspace || workspace.machine.kind !== "vm") return undefined
  if (workspace.checkpointOperation?.status === "running") return "Wait for the checkpoint to finish."
  const action = workspace.lifecycleAction === "dismiss-error" ? undefined : workspace.lifecycleAction
  if (workspace.state === "starting" || action === "start") return `Wait until ${workspace.machine.name} finishes starting.`
  if (action === "stop") return `Wait until ${workspace.machine.name} finishes stopping.`
  if (action === "restart") return `Wait until ${workspace.machine.name} finishes restarting.`
  if (workspace.freshness === "stale") return workspace.computer && !workspace.computer.connected
    ? `${workspace.computer.name} is offline. Reconnect it to manage this sandbox.`
    : "Silo could not refresh this sandbox’s status."
  return undefined
}

export function workspaceRowTone(workspace?: ApplicationWorkspace): SandboxRowTone {
  if (workspace?.state === "failed" || workspace?.attention?.level === "error") return "error"
  if (workspace?.attention?.level === "warning") return "warning"
  // A start in progress reads as starting even while the reported state is still stopped.
  if (workspace?.lifecycleAction === "start" || workspace?.lifecycleAction === "restart") return "starting"
  return workspace?.state ?? "stopped"
}

