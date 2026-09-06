import { useEffect } from "react"
import { CircleAlert, CircleCheck, Loader2, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { commitLabel } from "@/features/application/model/repository-push"
import type { RepositoryPushOperation } from "@/features/application/model/application-source"

export function RepositoryPushFeedback({
  operation,
  workspace,
  repositoryPath,
  onRetry,
  onDismiss,
}: {
  operation: RepositoryPushOperation
  workspace: string
  repositoryPath: string
  onRetry: () => void
  onDismiss: (workspace: string, repositoryPath: string) => void
}) {
  useEffect(() => {
    if (operation.status !== "succeeded") return
    const timer = window.setTimeout(() => onDismiss(workspace, repositoryPath), 4_000)
    return () => window.clearTimeout(timer)
  }, [operation.status, onDismiss, repositoryPath, workspace])

  if (operation.status === "pushing") {
    return (
      <div className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Pushing {commitLabel(operation.commitCount)}…
      </div>
    )
  }
  if (operation.status === "succeeded") {
    return (
      <div className="flex h-6 items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400" role="status" aria-live="polite" aria-atomic="true">
        <CircleCheck className="size-3.5" aria-hidden="true" />
        Pushed {commitLabel(operation.commitCount)}.
      </div>
    )
  }
  return (
    <Collapsible className="grid w-full gap-1.5">
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5" role="alert" aria-live="assertive" aria-atomic="true">
        <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-40 flex-1 text-xs text-destructive">{operation.message}</span>
        {operation.diagnosticDetails && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs" aria-label={`Toggle push error details for ${repositoryPath}`}>
              Details
            </Button>
          </CollapsibleTrigger>
        )}
        <Button variant="outline" size="xs" onClick={onRetry} aria-label={`Retry push for ${repositoryPath}`}>
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      </div>
      {operation.diagnosticDetails && (
        <CollapsibleContent>
          <pre className="overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-muted-foreground">{operation.diagnosticDetails}</pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

