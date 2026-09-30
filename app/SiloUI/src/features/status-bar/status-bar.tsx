import { workspaceTarget } from "@/features/application/model/remote-computers"
import { ComputerBadge } from "@/features/sandboxes/components/computer-badge"
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import { CircleAlert, Code, GitBranch, Loader2, Monitor, Play, Power, RotateCw, Server, Square, Terminal, TriangleAlert } from "lucide-react"

import { ListCard, ListRow, ListRowDetails, ListRowIcon } from "@/components/list-row"
import { SiloMark } from "@/components/silo-mark"
import { Button } from "@/components/ui/button"
import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import { RepositoryPushFeedback } from "@/features/application/components/repository-push-feedback"
import type { ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"
import { commitLabel } from "@/features/application/model/repository-push"
import { SandboxAction, SandboxListItem, SandboxListRow } from "@/features/sandboxes/components/sandbox-list"
import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"
import { workspaceIconState, workspaceRowTone } from "@/features/sandboxes/model/workspace-presentation"
import { cn } from "@/lib/utils"
import { lifecycleOutcome, sandboxTargetLabel } from "./status-bar-model"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"
import type { StatusBarActions, WorkspaceMenuProps } from "./status-bar-types"
import { WorkspaceMenu } from "./workspace-menu"
import { StatusFolderPicker } from "./status-folder-picker"
import { QuitConfirmation } from "./quit-confirmation"
import { sandboxesStoppedByQuit } from "./quit-confirmation-model"

function OperationIssue({ title, detail, actionLabel, actionText = "Details", tone = "error", onReview, retry }: { title: string; detail: string; actionLabel: string; actionText?: string; tone?: "error" | "warning"; onReview: () => void; retry?: ReactNode }) {
  return (
    <ListCard className="mb-2" role={tone === "error" ? "alert" : "status"} aria-label={title}>
      <ListRow
        icon={tone === "error"
          ? <ListRowIcon className="bg-destructive/10 text-destructive"><CircleAlert className="size-3.5" aria-hidden="true" /></ListRowIcon>
          : <ListRowIcon className="bg-amber-500/10 text-amber-600 dark:text-amber-400"><TriangleAlert className="size-3.5" aria-hidden="true" /></ListRowIcon>}
        title={title}
        detail={detail}
        detailClassName="whitespace-normal break-words"
        actions={<div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="xs" aria-label={actionLabel} onClick={onReview}>{actionText}</Button>
          {retry}
        </div>}
      />
    </ListCard>
  )
}

function RepositoryPushes({ workspace, source, actions }: { workspace: ApplicationWorkspace; source: ApplicationSource; actions: StatusBarActions }) {
  const repositories = workspace.repositories.flatMap((repository) => {
    const operation = source.repositoryPushOperations.find((push) => push.workspace === workspaceTarget(workspace) && push.repositoryPath === repository.path)
    return operation?.status !== "failed" && (operation || repository.ahead > 0) ? [{ repository, operation }] : []
  })
  if (!repositories.length) return null
  const canPush = workspaceAvailability(workspace, source).canOpen
  return (
    <div className="grid gap-1 px-2 pb-2">
      {repositories.map(({ repository, operation }) => (
        <div key={repository.path} className="flex min-h-6 min-w-0 items-center gap-2" role="group" aria-label={`${repository.path} in ${workspace.machine.name}`}>
          <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-foreground" title={repository.path}>
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{repository.path.split("/").filter(Boolean).at(-1) ?? repository.path}</span>
          </span>
          {operation ? <RepositoryPushFeedback
            operation={operation}
            workspace={workspaceTarget(workspace)}
            repositoryPath={repository.path}
            onRetry={() => actions.pushRepository(workspaceTarget(workspace), repository.path)}
            onDismiss={actions.dismissRepositoryPush}
            showSuccess
          /> : <Button variant="outline" size="xs" disabled={!canPush} aria-label={`Push ${commitLabel(repository.ahead)} for ${repository.path} in ${workspace.machine.name}`} onClick={() => { if (canPush) actions.pushRepository(workspaceTarget(workspace), repository.path) }}>
            Push {commitLabel(repository.ahead)}
          </Button>}
        </div>
      ))}
    </div>
  )
}

/**
 * `quitRequest` lets a host-side quit request (menu, ⌘Q, backend event) open the same
 * confirmation as the power button: bump it to a new number for each request.
 */
export function StatusBarContent({ source, actions, focusContent, workspaceMenu: WorkspaceActions = WorkspaceMenu, quitRequest }: { source: ApplicationSource; actions: StatusBarActions; focusContent: () => void; workspaceMenu?: ComponentType<WorkspaceMenuProps>; quitRequest?: number }) {
  const [quitPending, setQuitPending] = useState(false)
  const stoppedByQuit = sandboxesStoppedByQuit(source.workspaces)
  function requestQuit() {
    if (stoppedByQuit.length) setQuitPending(true)
    else actions.quit()
  }
  const lastQuitRequest = useRef(quitRequest)
  useEffect(() => {
    if (quitRequest === lastQuitRequest.current) return
    lastQuitRequest.current = quitRequest
    if (quitRequest !== undefined) requestQuit()
  })
  const [hasNavigated, setHasNavigated] = useState(false)
  const [folderWorkspace, setFolderWorkspace] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{ workspace: string; action: "stop" | "restart" } | null>(null)
  const repair = source.runtimeRepair
  const folders = source.workspaces.find(({ machine }) => machine.id === folderWorkspace)
  const failedPushes = source.repositoryPushOperations.filter((operation) => operation.status === "failed")
  const failedConfiguration = source.sandboxConfigurationOperation?.status === "failed" ? source.sandboxConfigurationOperation : null
  const approval = source.sandboxConfigurationOperation?.status === "awaiting-approval" ? source.sandboxConfigurationOperation : null

  function openFolders(id: string) {
    setHasNavigated(true)
    setFolderWorkspace(id)
  }

  if (folders && workspaceAvailability(folders, source).canOpen) {
    return <div key="folders" className="status-page status-page-forward flex max-h-[518px] shrink-0 flex-col overflow-hidden">
      <StatusFolderPicker listDirectory={actions.listWorkspaceDirectory} workspace={folders} editor={source.preferences.editor} onBack={() => { setFolderWorkspace(null); focusContent() }} onOpen={(path) => actions.openEditor(workspaceTarget(folders), path)} />
    </div>
  }

  return (
    <div key="sandboxes" className={cn("status-page flex max-h-[518px] shrink-0 flex-col overflow-hidden", hasNavigated && "status-page-back")}>
      <div className="shrink-0 px-2 pt-2">
        {repair && <ListCard className="mb-2">
          <ListRow
            icon={<ListRowIcon className="bg-destructive/10 text-destructive"><CircleAlert className="size-3.5" /></ListRowIcon>}
            title="System issue"
            detail={repair.reason}
            actions={<Button variant="outline" size="xs" onClick={() => actions.openSilo({ tab: "system" })}>View issue</Button>}
          />
        </ListCard>}
        {failedConfiguration && <OperationIssue
          title="Sandbox changes failed"
          detail={failedConfiguration.error.message}
          actionLabel="Review sandbox changes"
          onReview={() => actions.openSilo({ workspaceSection: "overview" })}
        />}
        {approval && <OperationIssue
          tone="warning"
          title="Sandbox changes need approval"
          detail={approval.result.message}
          actionLabel="Review sandbox changes"
          actionText="Review"
          onReview={() => actions.openSilo({ workspaceSection: "overview" })}
        />}
        {failedPushes.map((operation) => {
          const workspace = source.workspaces.find(workspace => workspaceTarget(workspace) === operation.workspace)
          const canRetry = workspace && workspace.repositories.some(({ path, ahead }) => path === operation.repositoryPath && ahead > 0) && workspaceAvailability(workspace, source).canOpen
          const sandbox = sandboxTargetLabel(operation.workspace, source)
          return <OperationIssue
            key={`${operation.workspace}:${operation.repositoryPath}`}
            title={`Push failed · ${sandbox}`}
            detail={`${operation.repositoryPath} · ${operation.message}`}
            actionLabel={`Review push failure for ${sandbox}, ${operation.repositoryPath}`}
            onReview={() => actions.openSilo({ workspace: operation.workspace, workspaceSection: "files" })}
            retry={<Button variant="outline" size="xs" aria-label={`Retry push for ${operation.repositoryPath}`} disabled={!canRetry} onClick={() => { if (canRetry) actions.pushRepository(operation.workspace, operation.repositoryPath) }}><RotateCw />Retry</Button>}
          />
        })}
      </div>
      <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain px-2 pb-2">
        {source.workspaces.length ? <ListCard className="border-0">
          <ol aria-label="Sandboxes" className="divide-y">
            {source.workspaces.map((workspace) => {
              const { machine } = workspace
  const target = workspaceTarget(workspace)
              const availability = workspaceAvailability(workspace, source)
              const pending = confirmation?.workspace === target ? confirmation : null
              const pendingSecrets = machine.kind === "vm" && !workspace.computer ? source.secrets.filter((secret) => secret.state === "restart-required" && secret.workspaces.includes(machine.name)).map(({ name }) => name) : []
              const activity = source.activities.find((item) => item.category === "sandbox" && item.workspace === target && item.status === "running")
              const review = workspace.state === "failed" || workspace.attention?.level === "error"
              // A failed Start leaves the sandbox "Stopped": show the failure instead of a neutral row.
              const lifecycle = lifecycleOutcome(workspace)
              const detail = workspace.attention?.message ?? (workspace.state === "failed" ? workspace.stateDetail : workspace.freshness === "stale" ? workspace.computer ? "Computer unavailable · Last known status" : "Last known status" : lifecycle?.text)
              return <SandboxListItem key={machine.id} aria-label={machine.name} aria-busy={availability.busy || undefined}>
                <SandboxListRow
                  name={machine.name}
                  kind={machine.kind}
                  kindBadge={workspace.computer ? <ComputerBadge computer={workspace.computer} /> : undefined}
                  iconState={lifecycle?.error ? "error" : workspaceIconState(workspace)}
                  tone={workspace.freshness === "stale" ? "warning" : lifecycle?.error ? "error" : workspaceRowTone(workspace)}
                  icon={availability.busy ? <span className="relative shrink-0">
                    <ListRowIcon>{machine.kind === "vm" ? <Monitor className="size-3.5" /> : <Server className="size-3.5" />}</ListRowIcon>
                    <span className="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-background"><Loader2 className="size-2.5 animate-spin" aria-hidden="true" /></span>
                  </span> : undefined}
                  detail={<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="truncate" title={availability.busy ? activity?.title ?? workspace.stateDetail : detail}>
                      {availability.busy ? <span className="font-medium text-amber-700 dark:text-amber-400">{workspace.lifecycleAction ? (workspace.lifecycleAction === "restart" ? "Restarting…" : workspace.lifecycleAction === "stop" ? "Stopping…" : "Starting…") : activity?.title ?? (workspace.state === "starting" ? workspace.stateDetail : "Working…")}</span> : <><WorkspaceStateLabel state={workspace.state} />{detail && <span> · {detail}</span>}</>}
                    </span>
                    {pendingSecrets.length > 0 && <SecretChangesLabel workspace={machine.name} state={workspace.state} secrets={pendingSecrets} />}
                  </span>}
                  detailClassName="overflow-visible whitespace-normal"
                  actions={<>
                    {!availability.busy && (!repair || workspace.computer) && (review
                      ? <SandboxAction label={`See logs for ${machine.name}`} onClick={() => actions.openSilo({ workspace: target, workspaceSection: "logs" })}><Terminal /></SandboxAction>
                      : workspace.freshness === "stale" ? <SandboxAction label={`Retry ${machine.name} status`} onClick={actions.refresh}><RotateCw /></SandboxAction>
                        : availability.canOpen ? <>
                          <SandboxAction label={`Open ${machine.name} in ${source.preferences.terminal}`} onClick={() => actions.openTerminal(target)}><Terminal /></SandboxAction>
                          <SandboxAction label={`Open ${machine.name} in ${source.preferences.editor}`} onClick={() => openFolders(machine.id)}><Code /></SandboxAction>
                        </> : availability.canStart ? <SandboxAction label={`Start ${machine.name}`} onClick={() => actions.startWorkspace(target)}><Play /></SandboxAction>
                          : <SandboxAction label={`Open ${machine.name} in Silo`} onClick={() => actions.openSilo({ workspace: target })}><SiloMark /></SandboxAction>)}
                    <WorkspaceActions workspace={workspace} source={source} actions={actions} onFolders={() => openFolders(machine.id)} onConfirm={(action) => setConfirmation({ workspace: target, action })} />
                  </>}
                />
                <RepositoryPushes workspace={workspace} source={source} actions={actions} />
                {pending && <ListRowDetails label={`${pending.action === "stop" ? "Stop" : "Restart"} ${machine.name}?`} className="gap-2 pl-0">
                  <p className="text-[11px] text-muted-foreground">{pending.action === "stop" ? "Stop" : "Restart"} {machine.name}{workspace.computer ? ` on ${workspace.computer.name}` : ""}? Running processes will be interrupted.</p>
                  <div className="flex justify-end gap-1.5">
                    <Button variant="ghost" size="xs" onClick={() => setConfirmation(null)}>Cancel</Button>
                    <Button variant="destructive" size="xs" disabled={pending.action === "stop" ? !availability.canStop : !availability.canRestart} onClick={() => {
                      if (pending.action === "stop" ? !availability.canStop : !availability.canRestart) return
                      setConfirmation(null)
                      if (pending.action === "stop") actions.stopWorkspace(target)
                      else actions.restartWorkspace(target)
                    }}>{pending.action === "stop" ? <Square /> : <RotateCw />}{pending.action === "stop" ? "Stop" : "Restart"}</Button>
                  </div>
                </ListRowDetails>}
              </SandboxListItem>
            })}
          </ol>
        </ListCard> : <div className="grid justify-items-center gap-1.5 py-8 text-center">
          <ListRowIcon><Monitor className="size-3.5" /></ListRowIcon>
          <p className="text-[13px] font-medium">No sandboxes yet</p>
          <p className="text-[11px] text-muted-foreground">Add your first sandbox in Silo.</p>
        </div>}
      </div>
      <footer className="flex shrink-0 items-center justify-between border-t px-2 py-2">
        {quitPending && stoppedByQuit.length
          ? <QuitConfirmation names={stoppedByQuit} onCancel={() => { setQuitPending(false); focusContent() }} onQuit={() => { setQuitPending(false); actions.quit() }} />
          : <>
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => actions.openSilo()}><SiloMark data-icon="inline-start" /><span>Open Silo…</span></Button>
            <SandboxAction label="Quit Silo" onClick={requestQuit}><Power /></SandboxAction>
          </>}
      </footer>
    </div>
  )
}
