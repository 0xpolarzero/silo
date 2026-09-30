import { z } from "zod"
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
  kind: "capture" | "fork" | "restore" | "delete"
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

/** Storage and Delete availability per checkpoint (`read_checkpoint_usage`). */
export const checkpointUsageSchema = z.object({
  /** Host space this sandbox's checkpoints use, each saved state counted once; null when unknown. */
  totalBytes: z.number().int().nonnegative().nullable(),
  checkpoints: z.array(z.object({
    id: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    /** Other sandboxes that depend on the checkpoint. */
    usedBy: z.array(z.string()).optional(),
    /** Why Delete is unavailable; absent when the checkpoint can be deleted. */
    deleteBlocker: z.string().optional(),
  })),
})
export type CheckpointUsage = z.infer<typeof checkpointUsageSchema>
