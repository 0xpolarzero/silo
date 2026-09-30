import { z } from "zod"

/**
 * What an operation is, as classified by the backend gate (`OperationKind` in
 * `runtime/operation_gate.rs`). The UI decides from the kind, never from the label text.
 */
export const operationKinds = [
  "lifecycle",
  "checkpointCapture",
  "checkpointRestore",
  "checkpointFork",
  "checkpointDelete",
  "export",
  "import",
  "storageReclaim",
  "githubApply",
  "push",
  "portPublish",
  "portRemove",
  "shutdown",
  "other",
] as const
export type OperationKind = (typeof operationKinds)[number]

/** A single VM-changing operation reported by the runtime operation gate. */
export interface OperationEntry {
  id: number
  label: string
  /** What the operation is; see {@link OperationKind}. Unknown or missing reads as `other`. */
  kind: OperationKind
  /** Stable VM id this operation is scoped to; `null` for computer-wide operations. */
  vmId: string | null
  /** VM display name captured when the operation was admitted; `null` for
   * computer-wide operations. For display only — matching keys on `vmId`. */
  vmName: string | null
  /** Unix epoch milliseconds when the operation started running or began waiting. */
  sinceMs: number
  /** Whether the user may cancel this operation now. Waiting entries are always
   * cancellable; a running entry is cancellable only when its work opted in. */
  cancellable: boolean
  /** Expected maximum duration in milliseconds, used to flag slow operations.
   * `null` when the operation carried no expectation. */
  expectedMs: number | null
  /** True for a waiting entry whose turn is held up by internal background maintenance
   * that is itself hidden from this queue. Lets the UI explain the wait without naming an
   * operation the user never started. Always false for running entries. */
  blockedByHidden: boolean
}

export interface OperationQueue {
  running: OperationEntry[]
  /** In admission order. */
  waiting: OperationEntry[]
}

export const operationEntrySchema = z.object({
  id: z.number().int().nonnegative(),
  label: z.string(),
  kind: z.enum(operationKinds).catch("other").default("other"),
  vmId: z.string().nullable(),
  vmName: z.string().nullable(),
  sinceMs: z.number().int().nonnegative(),
  cancellable: z.boolean(),
  expectedMs: z.number().int().nonnegative().nullable(),
  blockedByHidden: z.boolean().default(false),
})

export const operationQueueSchema = z.object({
  running: z.array(operationEntrySchema),
  waiting: z.array(operationEntrySchema),
})

export const emptyOperationQueue: OperationQueue = { running: [], waiting: [] }

/** Kinds that already show their own progress or result notification, so the queue toast skips them. */
const SELF_NOTIFIED_KINDS: ReadonlySet<OperationKind> = new Set([
  "lifecycle",
  "checkpointCapture",
  "checkpointRestore",
  "checkpointFork",
  "checkpointDelete",
  "export",
  "import",
  "storageReclaim",
  "githubApply",
  "push",
  "portPublish",
  "portRemove",
])

/** True when an entry already has its own notification and needs no queue toast. */
export function hasOwnNotification(entry: OperationEntry): boolean {
  return SELF_NOTIFIED_KINDS.has(entry.kind)
}

/** True when an entry is an export/import operation shown by its own transfer toast. */
export function isTransferOperation(entry: OperationEntry): boolean {
  return entry.kind === "export" || entry.kind === "import"
}

/** The queue with entries that have their own notification removed. */
export function toastableQueue(queue: OperationQueue): OperationQueue {
  return {
    running: queue.running.filter((entry) => !hasOwnNotification(entry)),
    waiting: queue.waiting.filter((entry) => !hasOwnNotification(entry)),
  }
}

/**
 * The runtime gate lets a VM-scoped operation run when nothing computer-wide and
 * nothing for the same VM is ahead of it. A computer-wide operation conflicts with
 * everything. This mirrors the backend `Scope::conflicts` rule.
 */
export function operationsConflict(a: OperationEntry, b: OperationEntry): boolean {
  return a.vmId === null || b.vmId === null || a.vmId === b.vmId
}

/**
 * Operations that keep `entry` from being admitted: conflicting running work, then
 * conflicting waiters admitted before it. The gate is FIFO, so an earlier waiter holds
 * `entry` back even while that waiter is itself waiting. Mirrors `State::admissible`.
 */
export function blockingOperations(queue: OperationQueue, entry: OperationEntry): OperationEntry[] {
  const position = queue.waiting.findIndex((waiting) => waiting.id === entry.id)
  const earlier = position < 0 ? [] : queue.waiting.slice(0, position)
  return [...queue.running, ...earlier].filter((other) => operationsConflict(other, entry))
}

/**
 * True when `entry`'s scope is the VM with stable id `vmId`. The runtime gate keys
 * per-VM entries by the stable id, so matching is by id alone and survives a rename.
 * Callers must not pass a remote computer's VM here: those operations run on that
 * computer's own gate and never appear in this local queue.
 */
export function operationMatchesVm(entry: OperationEntry, vmId: string): boolean {
  return entry.vmId === vmId
}

/**
 * The waiting operation that a VM row should surface: the earliest waiter whose
 * scope is this VM. Computer-wide waiters are reported by the global indicator.
 */
export function waitingOperationForVm(queue: OperationQueue, vmId: string): OperationEntry | undefined {
  return queue.waiting.find((entry) => operationMatchesVm(entry, vmId))
}

/** True when a matching operation for this VM is already running or waiting (a duplicate request). */
export function hasPendingOperationForVm(queue: OperationQueue, vmId: string): boolean {
  return [...queue.running, ...queue.waiting].some((entry) => operationMatchesVm(entry, vmId))
}

/**
 * True when a runtime error message reports a user-requested cancellation rather
 * than a genuine failure. The backend renders both cancellation paths with the
 * stable suffix "was cancelled." — `RuntimeError::Cancelled` (`"<operation> was
 * cancelled."`) and `GateError::Cancelled` (`"The operation was cancelled."`).
 * Matching that suffix keeps cancellations out of the error-styled failure UI.
 */
export function isCancelledError(message: string): boolean {
  return /was cancelled\.?\s*$/i.test(message.trim())
}

/** Human-readable neutral label for a cancelled lifecycle action, e.g. "Stop cancelled". */
export function cancelledActionLabel(action: "start" | "stop" | "restart" | "dismiss-error"): string {
  const verb = action === "restart" ? "Restart" : action === "stop" ? "Stop" : action === "dismiss-error" ? "Dismiss" : "Start"
  return `${verb} cancelled`
}

/** Running operations that a quitting overlay is waiting on, joined for display. */
export function shutdownWaitingLabel(queue: OperationQueue): string | undefined {
  const running = queue.running.filter((entry) => entry.kind !== "shutdown")
  if (running.length === 0) return undefined
  return `Waiting for ${joinLabels(running.map((entry) => entry.label))}…`
}

/** The running operations a quitting overlay could offer to cancel (opted-in cancellable). */
export function cancellableRunning(queue: OperationQueue): OperationEntry[] {
  return queue.running.filter((entry) => entry.cancellable && entry.kind !== "shutdown")
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
  if (blockers.length === 0) {
    // The blocker may be internal background maintenance the user never started, which is
    // kept out of the queue; describe it generically rather than leaving a bare "Waiting…".
    return entry.blockedByHidden ? "Waiting for background maintenance…" : "Waiting…"
  }
  return `Waiting for ${joinLabels(blockers.map((blocker) => blocker.label))}…`
}

/** Fallback threshold when an operation carries no expected duration. */
export const STUCK_OPERATION_MS = 10 * 60 * 1000

export function operationElapsedMs(entry: OperationEntry, now: number): number {
  return Math.max(0, now - entry.sinceMs)
}

/** The age past which an operation is flagged as taking longer than expected. */
export function stuckThresholdMs(entry: OperationEntry): number {
  return entry.expectedMs ?? STUCK_OPERATION_MS
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
  return operationElapsedMs(entry, now) >= stuckThresholdMs(entry)
}
