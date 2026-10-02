import { useEffect, useLayoutEffect, useRef } from "react"
import { commitLabel } from "@/features/application/model/repository-push"
import type { RepositoryPushOperation } from "@/features/application/model/application-source"
import type { NoticeSandbox } from "@/desktop/notices"
import type { OperationQueue } from "@/features/application/model/operation-queue"
import { dismissOperationToast, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"
import type { PushRepository } from "./repository-push-feedback"

const pushToastId = (operation: RepositoryPushOperation) => `repository-push:${operation.workspace}:${operation.repositoryPath}`
const repositoryName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

/**
 * Announces backend-driven push transitions as notifications: loading (with Cancel once the host accepts it),
 * then a success that stays until closed (the finished operation is then cleared) or a failure with Retry.
 * Operations already finished when first seen are not announced.
 */
export function useRepositoryPushToasts(
  operations: RepositoryPushOperation[],
  { onPush, onDismiss, resolveSandbox, queue, onCancel }: {
    /** Retries a failed push of the same confirmed target. */
    onPush: PushRepository
    onDismiss: (workspace: string, repositoryPath: string) => void
    /** Resolves the sandbox a push target belongs to, for the system notification. */
    resolveSandbox?: (workspace: string) => NoticeSandbox | undefined
    /** This computer's operation queue; a running push that accepts cancellation gets a Cancel button. */
    queue?: OperationQueue
    onCancel?: (operationId: number) => void
  },
) {
  const seen = useRef<Map<string, string> | null>(null)
  const callbacks = useRef({ onPush, onDismiss, resolveSandbox, onCancel })
  useLayoutEffect(() => { callbacks.current = { onPush, onDismiss, resolveSandbox, onCancel } }, [onPush, onDismiss, resolveSandbox, onCancel])
  useEffect(() => {
    const initial = seen.current === null
    const previous = seen.current ?? new Map<string, string>()
    const next = new Map<string, string>()
    for (const operation of operations) {
      const id = pushToastId(operation)
      const cancelId = operation.status === "pushing" && onCancel
        ? queue?.running.find((entry) => entry.kind === "push" && entry.cancellable && entry.vmName === operation.workspace)?.id
        : undefined
      const state = cancelId === undefined ? operation.status : `${operation.status}:${cancelId}`
      next.set(id, state)
      const before = previous.get(id)
      if (before === state) continue
      const name = repositoryName(operation.repositoryPath)
      if (operation.status === "pushing") {
        showOperationProgress(id, {
          title: `Pushing ${commitLabel(operation.commitCount)}`,
          step: operation.message ? `${name} · ${operation.message}` : name,
          sandbox: operation.workspace,
          cancel: cancelId === undefined ? undefined : {
            confirm: { prompt: "Stop this push? If GitHub is already receiving it, the branch may still change.", confirmLabel: "Stop push", keepLabel: "Keep pushing" },
            onCancel: () => callbacks.current.onCancel?.(cancelId),
          },
        })
      } else if (operation.status === "succeeded") {
        // Nothing stays inline for a finished push, so clear it; only announce one that finished while watching.
        if (!initial) showOperationSuccess(id, `Pushed ${commitLabel(operation.commitCount)} · ${name}`, { sandbox: operation.workspace, persist: true, noticeSandbox: callbacks.current.resolveSandbox?.(operation.workspace) })
        callbacks.current.onDismiss(operation.workspace, operation.repositoryPath)
      } else if (initial) {
        continue
      } else if (operation.status === "failed") {
        showOperationFailure(id, `Push failed · ${name}`, {
          description: operation.message,
          sandbox: operation.workspace,
          noticeSandbox: callbacks.current.resolveSandbox?.(operation.workspace),
          // The user confirmed this exact target before; a retry pushes it again or aborts if the sandbox moved on.
          retry: operation.target ? () => callbacks.current.onPush(operation.workspace, operation.repositoryPath, operation.commitCount, operation.target!) : undefined,
        })
      } else {
        dismissOperationToast(id)
      }
    }
    for (const [id, state] of previous) if (state.startsWith("pushing") && !next.has(id)) dismissOperationToast(id)
    seen.current = next
  }, [operations, queue, onCancel])
}

