import { useEffect, useRef, useState, type ReactNode } from "react"
import { CircleAlert, CircleCheck, Loader2, RotateCw } from "lucide-react"

import { ConfirmBody, ConfirmPopover } from "@/components/confirm-popover"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { commitLabel, pushTarget, shortCommit } from "@/features/application/model/repository-push"
import type { ApplicationRepository, RepositoryPushOperation, RepositoryPushTarget } from "@/features/application/model/application-source"
import type { NoticeSandbox } from "@/desktop/notices"
import type { OperationQueue } from "@/features/application/model/operation-queue"
import { dismissOperationToast, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"

const pushToastId = (operation: RepositoryPushOperation) => `repository-push:${operation.workspace}:${operation.repositoryPath}`
const repositoryName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

export type PushRepository = (workspace: string, repositoryPath: string, commitCount: number, target: RepositoryPushTarget) => void

/** Every push names its repository and branch first (owner decision 1); the host then pushes exactly this commit. */
function pushConfirmation(target: RepositoryPushTarget, commitCount: number) {
  return {
    title: `Push to ${target.repository}?`,
    description: `Branch ${target.branch} · ${commitLabel(commitCount)} · ${shortCommit(target.commit)}`,
    confirmLabel: "Push",
  }
}

const UNCONFIRMABLE = "Silo cannot tell where this repository pushes. It needs a GitHub origin; refresh repositories, or update Silo on the computer that runs this sandbox."

/**
 * The push button: asks for confirmation naming the repository, branch and commit, then pushes that
 * target. Disabled when the sandbox did not report a GitHub destination.
 */
export function RepositoryPushButton({ repository, disabled = false, label, onPush, children }: {
  repository: ApplicationRepository
  disabled?: boolean
  /** Accessible name of the button. */
  label?: string
  onPush: (target: RepositoryPushTarget) => void
  children: ReactNode
}) {
  const target = pushTarget(repository)
  const button = <Button variant="outline" size="xs" disabled={disabled || !target} aria-label={label} title={target ? undefined : UNCONFIRMABLE}>{children}</Button>
  if (!target || disabled) return button
  return <ConfirmPopover {...pushConfirmation(target, repository.ahead)} onConfirm={() => onPush(target)}>{button}</ConfirmPopover>
}

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
  callbacks.current = { onPush, onDismiss, resolveSandbox, onCancel }
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

/** Compact in-row state for a push. Results are announced by notifications; only states that need attention or a decision stay. */
export function RepositoryPushFeedback({
  operation,
  workspace,
  repositoryPath,
  repository,
  onPush,
  onDismiss,
  showSuccess = false,
  disabled = false,
}: {
  operation: RepositoryPushOperation
  workspace: string
  repositoryPath: string
  /** The repository as the sandbox reports it now; Retry confirms and pushes its current target. */
  repository?: ApplicationRepository
  onPush: (target: RepositoryPushTarget) => void
  onDismiss: (workspace: string, repositoryPath: string) => void
  /** Show the success line and clear it after a few seconds. For surfaces without notifications. */
  showSuccess?: boolean
  /** The sandbox must be available to retry a push. */
  disabled?: boolean
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
  return <FailedPush operation={operation} repositoryPath={repositoryPath} repository={repository} onPush={onPush} disabled={disabled} />
}

function FailedPush({ operation, repositoryPath, repository, onPush, disabled }: {
  disabled: boolean
  operation: Extract<RepositoryPushOperation, { status: "failed" }>
  repositoryPath: string
  repository?: ApplicationRepository
  onPush: (target: RepositoryPushTarget) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const target = repository ? pushTarget(repository) : null
  function change(next: boolean) {
    setOpen(next)
    if (!next) setConfirming(false)
  }
  return (
    <div className="flex h-6 items-center gap-1.5">
      <Popover open={open} onOpenChange={change}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" aria-label={`Push failed for ${repositoryPath}. Show details`}>
            <CircleAlert aria-hidden="true" />
            Push failed
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-80 max-w-[calc(100vw-2rem)] gap-2 text-xs">
          {confirming && !disabled && target && repository
            ? <ConfirmBody {...pushConfirmation(target, repository.ahead)} onConfirm={() => onPush(target)} onClose={() => change(false)} />
            : <>
              <p className="text-destructive">{operation.message}</p>
              {operation.diagnosticDetails && <pre className="max-h-48 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-muted-foreground">{operation.diagnosticDetails}</pre>}
              <Button className="justify-self-start" variant="outline" size="xs" disabled={disabled || !target} title={target ? undefined : UNCONFIRMABLE} onClick={() => setConfirming(true)} aria-label={`Retry push for ${repositoryPath}`}>
                <RotateCw aria-hidden="true" />
                Retry
              </Button>
            </>}
        </PopoverContent>
      </Popover>
    </div>
  )
}
