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
 */
export function sandboxBusyReason(workspace?: ApplicationWorkspace): string | undefined {
  if (!workspace || workspace.machine.kind !== "vm") return undefined
  const action = workspace.lifecycleAction === "dismiss-error" ? undefined : workspace.lifecycleAction
  if (workspace.state === "starting" || action === "start") return `Wait until ${workspace.machine.name} finishes starting.`
  if (action === "stop") return `Wait until ${workspace.machine.name} finishes stopping.`
  if (action === "restart") return `Wait until ${workspace.machine.name} finishes restarting.`
  return undefined
}

export function workspaceRowTone(workspace?: ApplicationWorkspace): SandboxRowTone {
  if (workspace?.state === "failed" || workspace?.attention?.level === "error") return "error"
  if (workspace?.attention?.level === "warning") return "warning"
  return workspace?.state ?? "stopped"
}

