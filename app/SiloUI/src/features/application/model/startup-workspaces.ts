import type { ApplicationWorkspace } from "./application-source"

/** Only sandboxes on this device can start when Silo opens. */
export function startupWorkspaceCandidates(workspaces: readonly ApplicationWorkspace[]): ApplicationWorkspace[] {
  return workspaces.filter(workspace => !workspace.device)
}

/** The startup selection before the user chooses one: the local "dev" sandbox, else the first local one. */
export function defaultStartupWorkspaceIds(workspaces: readonly ApplicationWorkspace[]): string[] {
  const candidates = startupWorkspaceCandidates(workspaces)
  const initial = candidates.find(({ machine }) => machine.name === "dev") ?? candidates[0]
  return initial ? [initial.machine.id] : []
}
