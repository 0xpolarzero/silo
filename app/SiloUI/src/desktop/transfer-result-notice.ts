import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { z } from "zod"

import type { TransferResultNotice, TransferResultNoticeBackend } from "@/features/application/model/transfer-result-notice"

// Only what the notice needs from `read_backup_state`. The application's own parser is strict about
// the rest of the state; this screen must not refuse to open Silo because of a field it never shows.
const unseenResultSchema = z.object({
  operationId: z.string().min(1).optional(),
  resultUnseen: z.boolean().optional(),
  operation: z.object({
    kind: z.string(),
    operation: z.enum(["backup", "restore"]).optional(),
    outcome: z.enum(["success", "failed", "cancelled"]).optional(),
    title: z.string().optional(),
    message: z.string().optional(),
    detail: z.string().optional(),
  }).passthrough().nullable(),
}).passthrough()

/** The unseen result in the state `read_backup_state` returned, if it holds one. */
export function unseenTransferResult(state: unknown): TransferResultNotice | null {
  const read = unseenResultSchema.parse(state)
  const { operation } = read
  if (!read.resultUnseen || !read.operationId || operation?.kind !== "result") return null
  if (!operation.operation || !operation.outcome || !operation.title || !operation.message) return null
  return {
    id: read.operationId,
    operation: operation.operation,
    outcome: operation.outcome,
    title: operation.title,
    message: operation.message,
    ...(operation.detail && { detail: operation.detail }),
  }
}

export const desktopTransferResultNoticeBackend: TransferResultNoticeBackend = {
  read: async () => unseenTransferResult(await invoke("read_backup_state")),
  acknowledge: async (id) => { await invoke("acknowledge_backup_result", { expectedOperationId: id }) },
  subscribe: refresh => listen("silo://application-state-changed", refresh),
}
