import { z } from "zod"

/** A single VM-changing operation reported by the runtime operation gate. */
export interface OperationEntry {
  id: number
  label: string
  /** `null` for computer-wide operations that touch every VM. */
  vm: string | null
  /** Unix epoch milliseconds when the operation started running or began waiting. */
  sinceMs: number
}

export interface OperationQueue {
  running: OperationEntry[]
  /** In admission order. */
  waiting: OperationEntry[]
}

export const operationEntrySchema = z.object({
  id: z.number().int().nonnegative(),
  label: z.string(),
  vm: z.string().nullable(),
  sinceMs: z.number().int().nonnegative(),
})

export const operationQueueSchema = z.object({
  running: z.array(operationEntrySchema),
  waiting: z.array(operationEntrySchema),
})

export const emptyOperationQueue: OperationQueue = { running: [], waiting: [] }

/**
 * The runtime gate lets a VM-scoped operation run when nothing computer-wide and
 * nothing for the same VM is ahead of it. A computer-wide operation conflicts with
 * everything. This mirrors the backend `Scope::conflicts` rule.
 */
export function operationsConflict(a: OperationEntry, b: OperationEntry): boolean {
  return a.vm === null || b.vm === null || a.vm === b.vm
}

/** Running operations that keep `entry` from being admitted, in start order. */
export function blockingOperations(queue: OperationQueue, entry: OperationEntry): OperationEntry[] {
  return queue.running.filter((running) => operationsConflict(running, entry))
}

/** True when `entry`'s scope matches any of the supplied VM identifiers. */
export function operationMatchesVm(entry: OperationEntry, identifiers: readonly string[]): boolean {
  return entry.vm !== null && identifiers.includes(entry.vm)
}

/**
 * The waiting operation that a VM row should surface: the earliest waiter whose
 * scope is this VM. Computer-wide waiters are reported by the global indicator.
 */
export function waitingOperationForVm(queue: OperationQueue, identifiers: readonly string[]): OperationEntry | undefined {
  return queue.waiting.find((entry) => operationMatchesVm(entry, identifiers))
}

/** True when a matching operation for this VM is already running or waiting (a duplicate request). */
export function hasPendingOperationForVm(queue: OperationQueue, identifiers: readonly string[]): boolean {
  return [...queue.running, ...queue.waiting].some((entry) => operationMatchesVm(entry, identifiers))
}

function joinLabels(labels: string[]): string {
  if (labels.length === 0) return ""
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`
}

/**
 * Human-readable status for a waiting operation: what it is waiting for. When no
 * blocking operation is running (an admission race), it simply reads "Waiting…".
 */
export function waitingStatusText(queue: OperationQueue, entry: OperationEntry): string {
  const blockers = blockingOperations(queue, entry)
  if (blockers.length === 0) return "Waiting…"
  return `Waiting for ${joinLabels(blockers.map((blocker) => blocker.label))}…`
}

/** A running operation is treated as possibly stuck once it exceeds this age. */
export const STUCK_OPERATION_MS = 10 * 60 * 1000

export function operationElapsedMs(entry: OperationEntry, now: number): number {
  return Math.max(0, now - entry.sinceMs)
}

/** Compact elapsed label such as "just now", "3 min", or "1 hr 4 min". */
export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000)
  if (totalMinutes < 1) return "just now"
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`
}

export function isOperationStuck(entry: OperationEntry, now: number): boolean {
  return operationElapsedMs(entry, now) >= STUCK_OPERATION_MS
}
