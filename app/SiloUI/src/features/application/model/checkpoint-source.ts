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

/** A Restore that did not finish (`unfinishedRestore` in the sandbox view). */
export interface UnfinishedRestore {
  /** The checkpoint being restored. */
  checkpointId: string
  checkpointName?: string | null
  /** "capturing" until the recovery checkpoint is saved, then "secured". */
  phase: "capturing" | "secured"
}

export interface PendingCheckpointRestore {
  checkpointId: string
  sourceWorkspace: string
  state: "full" | "disk"
}

/** Sandbox names already used on one device (`undefined` for this device), so a fork name conflict shows inline. */
export function sandboxNamesOnDevice(workspaces: readonly ApplicationWorkspace[], deviceId: string | undefined): string[] {
  return workspaces.filter(workspace => (workspace.device?.id ?? "") === (deviceId ?? "")).map(workspace => workspace.machine.name)
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
