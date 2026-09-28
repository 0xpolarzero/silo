import { useEffect, useState } from "react"
import { Clock, Loader2, X } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  formatElapsed,
  isOperationStuck,
  operationElapsedMs,
  waitingOperationForVm,
  waitingStatusText,
  type OperationEntry,
  type OperationQueue,
} from "@/features/application/model/operation-queue"

/** Small inline Cancel control for a queued or cancellable running operation. */
function CancelOperationButton({ entry, onCancel }: { entry: OperationEntry; onCancel: (id: number) => void }) {
  return (
    <button
      type="button"
      aria-label={`Cancel ${entry.label}`}
      title={`Cancel ${entry.label}`}
      onClick={() => onCancel(entry.id)}
      className="flex shrink-0 items-center gap-1 rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <X aria-hidden="true" className="size-3" />
      Cancel
    </button>
  )
}

/** Re-renders on an interval so running operations show a live elapsed time. */
function useNow(active: boolean, intervalMs = 30000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [active, intervalMs])
  return now
}

/**
 * Compact global indicator of VM-changing operations. Running operations show a
 * live elapsed time; waiting operations show what they are waiting for.
 */
export function OperationQueueIndicator({ queue, reduceMotion = false, onCancel }: { queue?: OperationQueue; reduceMotion?: boolean; onCancel?: (id: number) => void }) {
  const active = Boolean(queue && (queue.running.length > 0 || queue.waiting.length > 0))
  const now = useNow(active)
  if (!queue || !active) return null

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Sandbox operations"
      className="mb-3 grid gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs"
    >
      {queue.running.map((entry) => {
        const stuck = isOperationStuck(entry, now)
        const elapsed = formatElapsed(operationElapsedMs(entry, now))
        return (
          <div key={entry.id} className="flex min-w-0 items-center gap-2">
            <Loader2 aria-hidden="true" className={cn("size-3 shrink-0 text-muted-foreground", !reduceMotion && "animate-spin motion-reduce:animate-none")} />
            <span className="min-w-0 flex-1 truncate" title={entry.label}>{entry.label}</span>
            {stuck && (
              <span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">Taking longer than expected</span>
            )}
            <span
              className={cn(
                "shrink-0 tabular-nums",
                stuck ? "flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground",
              )}
            >
              {stuck && <Clock aria-hidden="true" className="size-3" />}
              {elapsed}
            </span>
            {onCancel && entry.cancellable && <CancelOperationButton entry={entry} onCancel={onCancel} />}
          </div>
        )
      })}
      {queue.waiting.map((entry) => (
        <div key={entry.id} className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span aria-hidden="true" className="ml-0.5 size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={entry.label}>{entry.label}</span>
          <span className="shrink-0 truncate">{waitingStatusText(queue, entry)}</span>
          {onCancel && <CancelOperationButton entry={entry} onCancel={onCancel} />}
        </div>
      ))}
    </div>
  )
}

/**
 * Inline per-VM waiting status shown near a sandbox's activity indicator when an
 * operation for that VM is waiting its turn behind other running work.
 */
export function WorkspaceWaitingStatus({ queue, vmId, onCancel }: { queue?: OperationQueue; vmId: string; onCancel?: (id: number) => void }) {
  if (!queue) return null
  const waiting = waitingOperationForVm(queue, vmId)
  if (!waiting) return null
  return (
    <span role="status" className="inline-flex items-center gap-1 text-muted-foreground">
      {waitingStatusText(queue, waiting)}
      {onCancel && <CancelOperationButton entry={waiting} onCancel={onCancel} />}
    </span>
  )
}
