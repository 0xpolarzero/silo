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
