import { z } from "zod"
import type { ApplicationWorkspace } from "./application-source"

export interface LogQuery {
  sandboxId: string
  computerId?: string
  query?: string
  source?: string
  since?: string
  until?: string
  cursor?: string
  limit?: number
  aroundId?: string
}
export const logEntrySchema = z.object({
  id: z.string(), line: z.string(), occurredAt: z.string(), sandboxId: z.string(),
  computerId: z.string(), source: z.string(), session: z.string().nullish(),
})
export const logPageSchema = z.object({
  entries: z.array(logEntrySchema), nextCursor: z.string().nullable(),
  oldestAvailableTimestamp: z.string().nullable(), newestAvailableTimestamp: z.string().nullable(),
  totalMatches: z.number(), timestampEstimated: z.boolean(),
})
export type LogEntry = z.infer<typeof logEntrySchema>
export type LogPage = z.infer<typeof logPageSchema>
export type LogLoader = (request: LogQuery) => Promise<LogPage>
export function logIdentity(workspace: ApplicationWorkspace): Pick<LogQuery, "sandboxId" | "computerId"> {
  return { sandboxId: workspace.computer?.vmId ?? workspace.machine.id, ...(workspace.computer && { computerId: workspace.computer.id }) }
}
export function formatLog(entry: LogEntry): string {
  return `${entry.occurredAt}\t${entry.computerId}\t${entry.sandboxId}\t${entry.source}\t${entry.session ?? ""}\t${entry.line}`
}
/** Deterministic browser fixtures supply their entire history, never a production fallback. */
export function fixtureLogPage(workspace: ApplicationWorkspace, request: LogQuery): LogPage {
  const all = workspace.logs.map((log, index): LogEntry => ({ ...log, id: String(index), sandboxId: workspace.machine.id, computerId: workspace.computer?.id ?? "local", source: "output" })).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  let matches = all.filter(entry => (!request.query || entry.line.toLowerCase().includes(request.query.toLowerCase())) && (!request.source || entry.source === request.source) && (!request.since || entry.occurredAt >= request.since) && (!request.until || entry.occurredAt <= request.until))
  if (request.aroundId) { const index = all.findIndex(entry => entry.id === request.aroundId); matches = all.slice(Math.max(0, index - 50), index + 51) }
  const offset = Number(request.cursor ?? 0), limit = request.limit ?? 200
  return { entries: matches.slice(offset, offset + limit), nextCursor: offset + limit < matches.length ? String(offset + limit) : null, totalMatches: matches.length, oldestAvailableTimestamp: all.at(-1)?.occurredAt ?? null, newestAvailableTimestamp: all[0]?.occurredAt ?? null, timestampEstimated: false }
}
