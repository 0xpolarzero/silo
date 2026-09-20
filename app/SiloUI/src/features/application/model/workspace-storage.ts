import { z } from "zod"

const bytes = z.number().int().nonnegative()
export const workspaceStorageStateSchema = z.object({
  history: z.array(z.object({
    at: z.number().int().nonnegative(),
    trigger: z.string(),
    reclaimedBytes: bytes.nullable(),
    error: z.string().nullable(),
  })).max(50).default([]),
  workspaceHostBytes: bytes,
  runtimeHostBytes: bytes,
  workspaceUsedBytes: bytes.nullable(),
  workspaceCapacityBytes: bytes.nullable(),
  lastReclaimedBytes: bytes.nullable(),
  lastTrimAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
})

export type WorkspaceStorageState = z.infer<typeof workspaceStorageStateSchema>
