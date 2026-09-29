import type { ApplicationWorkspace } from "./application-source"

export interface WorkspaceCheckpoint {
  id: string
  name: string
  createdAt: string
  scope: "full" | "disk"
  reason: "manual" | "before-restore"
  sizeBytes?: number
}

export interface WorkspaceCheckpointOperation {
  kind: "capture" | "fork" | "restore"
  status: "running" | "failed"
  stage: string
  error?: string
}

export interface PendingCheckpointRestore {
  checkpointId: string
  sourceWorkspace: string
  state: "full" | "disk"
}

/** Sandbox names already used on one computer (`undefined` for this computer), so a fork name conflict shows inline. */
export function sandboxNamesOnComputer(workspaces: readonly ApplicationWorkspace[], computerId: string | undefined): string[] {
  return workspaces.filter(workspace => (workspace.computer?.id ?? "") === (computerId ?? "")).map(workspace => workspace.machine.name)
}
