import { GitBranch, LoaderCircle, Pencil, RotateCw, UserRound } from "lucide-react"

import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { SetupNotice } from "@/features/onboarding/components/setup-notice"
import { SandboxList, SandboxListItem, SandboxListRow } from "@/features/sandboxes/components/sandbox-list"
import { machineSummary } from "@/features/sandboxes/model/machine-summary"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import type { ReviewQueueItemView, WorkspaceView } from "@/features/onboarding/model/onboarding-state"
import { cn } from "@/lib/utils"

interface ReviewStepProps {
  workspaceRetryable: boolean
  queueItems: ReviewQueueItemView[]
  machines: readonly SetupMachineConfiguration[]
  workspaces: WorkspaceView[]
  identitySummary: string
  githubSummary: string
  githubConnected?: boolean
  errorMessage?: string
  errorRecovery?: string
  onRetryWorkspaceSetup: () => void
  onEditStep?: (step: "workspaces" | "github") => void
}

const statusLabel: Record<ReviewQueueItemView["status"], string> = {
  idle: "Not started",
  queued: "Waiting",
  running: "In progress",
  succeeded: "Complete",
  failed: "Failed",
}

function ValidationBadge({ status }: { status: ReviewQueueItemView["status"] }) {
  return <span className={cn(
    "inline-flex shrink-0 items-center gap-1 text-[10px] font-normal",
    status === "failed" ? "text-destructive" : status === "running" ? "text-amber-700 dark:text-amber-400" : status === "succeeded" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
  )}>{status === "running" && <LoaderCircle className="size-2.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{statusLabel[status]}</span>
}

export function ReviewStep({ workspaceRetryable, queueItems, machines, workspaces, identitySummary, githubSummary, githubConnected = true, errorMessage, errorRecovery, onRetryWorkspaceSetup, onEditStep }: ReviewStepProps) {
  const identityItems = queueItems.filter(({ id }) => id === "identityRun" || id === "identityVerify")
  const githubItems = queueItems.filter(({ id }) => id === "githubRun" || id === "githubVerify")
  const githubStatus = githubItems.some(({ status }) => status === "failed") ? "failed" : githubItems.some(({ status }) => status === "running") ? "running" : githubItems.length === 2 && githubItems.every(({ status }) => status === "succeeded") ? "succeeded" : githubItems.some(({ status }) => status === "queued") ? "queued" : "idle"
  const githubComplete = githubItems.length === 2 && githubItems.every(({ status }) => status === "succeeded")
  const identityFailure = identityItems.find(({ status }) => status === "failed")
  const identityStatus = identityFailure ? "failed"
    : identityItems.some(({ status }) => status === "running") ? "running"
    : identityItems.some(({ status }) => status === "queued") ? "queued"
    : identityItems.length === 2 && identityItems.every(({ status }) => status === "succeeded") ? "succeeded" : "idle"

  return (
    <section aria-labelledby="review-title" className="grid gap-4">
      <h2 id="review-title" className="sr-only" data-visual-heading="hidden">Review setup</h2>

      {errorMessage && <SetupNotice
        title="Setup couldn’t finish"
        detail={errorMessage}
        recovery={errorRecovery}
        action={workspaceRetryable && <Button type="button" variant="outline" size="xs" onClick={onRetryWorkspaceSetup}><RotateCw aria-hidden="true" />Retry</Button>}
      />}

      <section aria-labelledby="review-machines-heading" className="min-w-0">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 id="review-machines-heading" className="text-xs font-medium">Sandboxes</h3>
          {onEditStep && <Button type="button" variant="ghost" size="xs" onClick={() => onEditStep("workspaces")} aria-label="Edit sandboxes"><Pencil aria-hidden="true" />Edit</Button>}
        </div>
        <SandboxList label="Sandboxes">
          {machines.map((machine, index) => {
            const workspace = workspaces.find(({ name }) => name === machine.name)
            const state = workspace?.status ?? "waiting"
            const status = state === "ready" ? "succeeded" : state === "working" ? "running" : state === "failed" ? "failed"
              : queueItems.some(({ id, status }) => (id === "workspaceRun" || id === "workspaceVerify") && status !== "idle") ? "queued" : "idle"
            const summary = machineSummary(machine)
            return <SandboxListItem key={machine.id} aria-busy={state === "working"}>
              <SandboxListRow
                name={machine.name}
                kind={machine.kind}
                leading={<span className="w-5 shrink-0 text-center font-mono text-[10px] tabular-nums text-muted-foreground">{index + 1}</span>}
                tone={state === "failed" ? "error" : state === "working" ? "starting" : state === "ready" ? "running" : "stopped"}
                iconState={state === "failed" ? "error" : "normal"}
                badge={<ValidationBadge status={status} />}
                detail={<span title={summary}>{summary}{workspace && state !== "ready" && workspace.detail !== "Waiting" ? ` · ${workspace.detail}` : ""}</span>}
                detailClassName={state === "failed" ? "whitespace-normal break-words" : undefined}
              />
            </SandboxListItem>
          })}
        </SandboxList>
      </section>

      <section aria-labelledby="review-preferences-heading">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 id="review-preferences-heading" className="text-xs font-medium">GitHub and Git identity</h3>
          {onEditStep && <Button type="button" variant="ghost" size="xs" onClick={() => onEditStep("github")} aria-label="Edit GitHub and Git identity"><Pencil aria-hidden="true" />Edit</Button>}
        </div>
        <ListCard divided>
          {[
            { title: "GitHub access", detail: githubSummary, Icon: GitBranch, complete: githubComplete },
            { title: "Git author", detail: identitySummary, Icon: UserRound, complete: identityStatus === "succeeded" },
          ].map(({ title, detail, Icon, complete }) => <ListRow
            key={title}
            icon={<ListRowIcon aria-hidden="true"><Icon className="size-3.5" /></ListRowIcon>}
            role="group"
            aria-label={title}
            className={complete ? "bg-emerald-500/[0.035] hover:bg-emerald-500/[0.07] focus-within:bg-emerald-500/[0.07]" : undefined}
            title={<>{title}{title === "Git author" ? <ValidationBadge status={identityStatus} /> : githubConnected ? <ValidationBadge status={githubStatus} /> : <span className="text-[10px] font-normal text-muted-foreground">Skipped</span>}</>}
            detail={title === "Git author" && identityFailure?.failure ? `${detail} · ${identityFailure.failure}` : detail}
            detailClassName={title === "Git author" && identityFailure ? "whitespace-normal break-words text-destructive" : undefined}
          />)}
        </ListCard>
      </section>
    </section>
  )
}
