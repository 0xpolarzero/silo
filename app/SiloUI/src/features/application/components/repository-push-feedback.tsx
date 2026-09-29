import { useEffect, useRef } from "react"
import { CircleAlert, CircleCheck, Loader2, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { commitLabel } from "@/features/application/model/repository-push"
import type { RepositoryPushOperation } from "@/features/application/model/application-source"
import { dismissOperationToast, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"

const pushToastId = (operation: RepositoryPushOperation) => `repository-push:${operation.workspace}:${operation.repositoryPath}`
const repositoryName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

/**
 * Announces backend-driven push transitions as notifications: loading, then a success that stays until closed
 * (the finished operation is then cleared) or a failure with Retry. Operations already finished when first
 * seen are not announced.
 */
export function useRepositoryPushToasts(
  operations: RepositoryPushOperation[],
  { onPush, onDismiss }: { onPush: (workspace: string, repositoryPath: string, commitCount: number) => void; onDismiss: (workspace: string, repositoryPath: string) => void },
) {
  const seen = useRef<Map<string, RepositoryPushOperation["status"]> | null>(null)
  const callbacks = useRef({ onPush, onDismiss })
  callbacks.current = { onPush, onDismiss }
  useEffect(() => {
    const initial = seen.current === null
    const previous = seen.current ?? new Map<string, RepositoryPushOperation["status"]>()
    const next = new Map<string, RepositoryPushOperation["status"]>()
    for (const operation of operations) {
      const id = pushToastId(operation)
      next.set(id, operation.status)
      const before = previous.get(id)
      if (before === operation.status) continue
      const name = repositoryName(operation.repositoryPath)
      if (operation.status === "pushing") {
        showOperationProgress(id, { title: `Pushing ${commitLabel(operation.commitCount)}`, step: operation.message ? `${name} · ${operation.message}` : name, sandbox: operation.workspace })
      } else if (operation.status === "succeeded") {
        // Nothing stays inline for a finished push, so clear it; only announce one that finished while watching.
        if (!initial) showOperationSuccess(id, `Pushed ${commitLabel(operation.commitCount)} · ${name}`, { sandbox: operation.workspace, persist: true })
        callbacks.current.onDismiss(operation.workspace, operation.repositoryPath)
      } else if (initial) {
        continue
      } else if (operation.status === "failed") {
        showOperationFailure(id, `Push failed · ${name}`, {
          description: operation.message,
          sandbox: operation.workspace,
          retry: () => callbacks.current.onPush(operation.workspace, operation.repositoryPath, operation.commitCount),
        })
      } else {
        dismissOperationToast(id)
      }
    }
    for (const [id, status] of previous) if (status === "pushing" && !next.has(id)) dismissOperationToast(id)
    seen.current = next
  }, [operations])
}

/** Compact in-row state for a push. Results are announced by notifications; only states that need attention or a decision stay. */
export function RepositoryPushFeedback({
  operation,
  workspace,
  repositoryPath,
  onRetry,
  onDismiss,
  showSuccess = false,
}: {
  operation: RepositoryPushOperation
  workspace: string
  repositoryPath: string
  onRetry: () => void
  onDismiss: (workspace: string, repositoryPath: string) => void
  /** Show the success line and clear it after a few seconds. For surfaces without notifications. */
  showSuccess?: boolean
}) {
  useEffect(() => {
    if (!showSuccess || operation.status !== "succeeded") return
    const timer = window.setTimeout(() => onDismiss(workspace, repositoryPath), 4_000)
    return () => window.clearTimeout(timer)
  }, [showSuccess, operation.status, onDismiss, repositoryPath, workspace])

  if (operation.status === "pushing") {
    return (
      <div className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {operation.message ?? `Pushing ${commitLabel(operation.commitCount)}…`}
      </div>
    )
  }
  if (operation.status === "unknown") {
    return <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate" title={operation.message}>{operation.message}</span>
      <Button className="shrink-0" variant="outline" size="xs" onClick={() => onDismiss(workspace, repositoryPath)}>I’ve checked GitHub</Button>
    </div>
  }
  if (operation.status === "succeeded") {
    if (!showSuccess) return null
    return (
      <div className="flex h-6 items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400" role="status" aria-live="polite" aria-atomic="true">
        <CircleCheck className="size-3.5" aria-hidden="true" />
        Pushed {commitLabel(operation.commitCount)}.
      </div>
    )
  }
  return (
    <div className="flex h-6 items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" aria-label={`Push failed for ${repositoryPath}. Show details`}>
            <CircleAlert aria-hidden="true" />
            Push failed
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-80 max-w-[calc(100vw-2rem)] gap-2 text-xs">
          <p className="text-destructive">{operation.message}</p>
          {operation.diagnosticDetails && <pre className="max-h-48 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-muted-foreground">{operation.diagnosticDetails}</pre>}
          <Button className="justify-self-start" variant="outline" size="xs" onClick={onRetry} aria-label={`Retry push for ${repositoryPath}`}>
            <RotateCw aria-hidden="true" />
            Retry
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
