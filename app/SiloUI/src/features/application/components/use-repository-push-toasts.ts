import { useEffect, useLayoutEffect, useRef } from "react"
import { commitLabel } from "@/features/application/model/repository-push"
import type { RepositoryPushOperation } from "@/features/application/model/application-source"
import type { NoticeComputer } from "@/desktop/notices"
import type { OperationQueue } from "@/features/application/model/operation-queue"
import { dismissOperationToast, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"
import type { PushRepository } from "./repository-push-feedback"

const pushToastId = (operation: RepositoryPushOperation) => `repository-push:${operation.computer}:${operation.repositoryPath}`
const repositoryName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

/**
 * Announces backend-driven push transitions as notifications: loading (with Cancel once the host accepts it),
 * then a success that stays until closed (the finished operation is then cleared), a failure with Retry,
 * or an unknown outcome that requires checking GitHub before another push.
 * Operations already finished when first seen are not announced.
 */
export function useRepositoryPushToasts(
  operations: RepositoryPushOperation[],
  { onPush, onDismiss, resolveComputer, queue, onCancel, enabled = true }: {
    /** Standalone pages can defer notifications to their application owner. */
    enabled?: boolean
    /** Retries a failed push of the same confirmed target. */
    onPush: PushRepository
    onDismiss: (computer: string, repositoryPath: string) => void
    /** Resolves the computer a push target belongs to, for the system notification. */
    resolveComputer?: (computer: string) => NoticeComputer | undefined
    /** This device's operation queue; a running push that accepts cancellation gets a Cancel button. */
    queue?: OperationQueue
    onCancel?: (operationId: number) => void
  },
) {
  const seen = useRef<Map<string, string> | null>(null)
  const callbacks = useRef({ onPush, onDismiss, resolveComputer, onCancel })
  useLayoutEffect(() => { callbacks.current = { onPush, onDismiss, resolveComputer, onCancel } }, [onPush, onDismiss, resolveComputer, onCancel])
  useEffect(() => {
    if (!enabled) return
    const initial = seen.current === null
    const previous = seen.current ?? new Map<string, string>()
    const next = new Map<string, string>()
    for (const operation of operations) {
      const id = pushToastId(operation)
      const computer = callbacks.current.resolveComputer?.(operation.computer)
      const cancelId = operation.status === "pushing" && onCancel
        ? queue?.running.find((entry) => entry.kind === "push" && entry.cancellable && (resolveComputer ? entry.computerId === computer?.id : entry.computerName === operation.computer))?.id
        : undefined
      const state = `${operation.status}:${JSON.stringify({
        count: operation.commitCount, message: "message" in operation ? operation.message : undefined, cancelId,
        repository: operation.target?.repository, branch: operation.target?.branch, commit: operation.target?.commit,
      })}`
      next.set(id, state)
      const before = previous.get(id)
      if (before === state) continue
      const name = repositoryName(operation.repositoryPath)
      if (operation.status === "pushing") {
        showOperationProgress(id, {
          title: `Pushing ${commitLabel(operation.commitCount)}`,
          step: operation.message ? `${name} · ${operation.message}` : name,
          computer: operation.computer,
          cancel: cancelId === undefined ? undefined : {
            confirm: { prompt: "Stop this push? If GitHub is already receiving it, the branch may still change.", confirmLabel: "Stop push", keepLabel: "Keep pushing" },
            onCancel: () => callbacks.current.onCancel?.(cancelId),
          },
        })
      } else if (operation.status === "succeeded") {
        // Nothing stays inline for a finished push, so clear it; only announce one that finished while watching.
        if (!initial) showOperationSuccess(id, `Pushed ${commitLabel(operation.commitCount)} · ${name}`, { computer: operation.computer, persist: true, noticeComputer: callbacks.current.resolveComputer?.(operation.computer) })
        callbacks.current.onDismiss(operation.computer, operation.repositoryPath)
      } else if (initial) {
        continue
      } else if (operation.status === "failed") {
        showOperationFailure(id, `Push failed · ${name}`, {
          description: operation.message,
          computer: operation.computer,
          noticeComputer: callbacks.current.resolveComputer?.(operation.computer),
          // The user confirmed this exact target before; a retry pushes it again or aborts if the computer moved on.
          retry: operation.target ? () => callbacks.current.onPush(operation.computer, operation.repositoryPath, operation.commitCount, operation.target!) : undefined,
        })
      } else if (operation.status === "unknown") {
        showOperationFailure(id, `Push outcome unknown · ${name}`, {
          description: operation.message,
          computer: operation.computer,
          noticeComputer: callbacks.current.resolveComputer?.(operation.computer),
          tone: "warning",
        })
      } else {
        dismissOperationToast(id)
      }
    }
    for (const [id, state] of previous) if ((state.startsWith("pushing") || state.startsWith("unknown")) && !next.has(id)) dismissOperationToast(id)
    seen.current = next
  }, [enabled, operations, queue, onCancel, resolveComputer])
}
