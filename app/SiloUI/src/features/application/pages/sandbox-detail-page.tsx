import { ChevronRight, Code, Play, Square, Terminal } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"

import { ActionsMenu, type MenuAction } from "@/components/actions-menu"
import { ConnectionIcon } from "@/components/connection-icon"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import { CheckpointPanel } from "@/features/application/components/checkpoint-panel"
import { WorkspaceWaitingStatus } from "@/features/application/components/operation-queue-panel"
import { emptyOperationQueue, waitingOperationForVm, cancelledActionLabel } from "@/features/application/model/operation-queue"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace, SandboxDetailTab } from "@/features/application/model/application-source"
import type { WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import { SshAccessRow, SshAccessBadges } from "@/features/application/pages/ssh-access-panel"
import { WorkspaceStoragePanel } from "@/features/application/pages/workspace-storage-panel"
import { ComputerBadge } from "@/features/sandboxes/components/computer-badge"
import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"

export interface SandboxDetailControls {
  onBack: () => void
  activeTab: SandboxDetailTab
  onSelectTab: (tab: SandboxDetailTab) => void
  readOnly: boolean
  configurationLocked: boolean
  workspaceOperationBusy: boolean
  canOpen: boolean
  canStart: boolean
  canStop: boolean
  menuActions: MenuAction[]
  onTerminal: () => void
  onEditor: () => void
  onStart: () => void
  onStop: () => void
  onRetryLifecycle?: () => void
  // Export a checkpoint's disks; progress is shown as a background toast.
  onCheckpointExport?: (checkpoint: WorkspaceCheckpoint) => void
  checkpointExportDisabled: boolean
}

function StatusLine({ workspace, source, readOnly, onCancel }: { workspace: ApplicationWorkspace; source: ApplicationSource; readOnly: boolean; onCancel?: ApplicationActions["cancelOperation"] }) {
  const state = workspace.state
  const lifecycle = workspace.lifecycleAction
  const lifecycleLabel = lifecycle === "dismiss-error" ? "Dismissing…" : lifecycle === "restart" ? "Restarting…" : lifecycle === "stop" ? "Stopping…" : "Starting…"
  const queueVmId = workspace.computer ? null : workspace.machine.id
  const waitingForVm = queueVmId !== null ? waitingOperationForVm(source.operationQueue ?? emptyOperationQueue, queueVmId) : undefined
  if (lifecycle) {
    return waitingForVm && queueVmId !== null
      ? <WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={readOnly ? undefined : onCancel} />
      : <span role="status" className="text-amber-700 dark:text-amber-400">{lifecycleLabel}</span>
  }
  if (workspace.computer?.busy) return <span role="status">Refreshing status…</span>
  if (workspace.computer && !workspace.computer.connected) return <span>Unavailable</span>
  return <span className="inline-flex items-center gap-1">
    <WorkspaceStateLabel state={state} />
    {queueVmId !== null && waitingForVm && <> · <WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={readOnly ? undefined : onCancel} /></>}
  </span>
}

function OverviewTab({ workspace }: { workspace: ApplicationWorkspace }) {
  const { machine } = workspace
  const rows: { label: string; value: ReactNode }[] = []
  if (machine.kind === "vm") {
    rows.push({ label: "CPU", value: `${machine.cpus} CPU${machine.cpus === 1 ? "" : "s"}` })
    rows.push({ label: "Memory", value: `${machine.memoryGiB} GB` })
    rows.push({ label: "Workspace disk", value: `${machine.workspaceStorageGiB} GB` })
  } else {
    rows.push({ label: "Host", value: `${machine.user}@${machine.host}:${machine.port}` })
  }
  const repositories = workspace.repositories ?? []
  const githubRepositories = workspace.githubRepositories ?? []
  const ports = workspace.ports ?? []
  const section = "grid gap-2 border-t border-border pt-3"
  return <div className="grid gap-3 text-xs">
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {rows.map(({ label, value }) => <div key={label} className="grid gap-0.5">
        <dt className="text-[11px] text-muted-foreground">{label}</dt>
        <dd className="font-medium">{value}</dd>
      </div>)}
    </dl>
    <div className={section}>
      <p className="text-[11px] font-medium text-muted-foreground">Repositories</p>
      {repositories.length === 0 && githubRepositories.length === 0
        ? <p className="text-muted-foreground">No repositories configured.</p>
        : <ul className="grid gap-1">
            {repositories.map(repo => <li key={repo.path} className="flex min-w-0 items-center justify-between gap-2"><span className="truncate" title={repo.path}>{repo.path}</span><span className="shrink-0 text-[11px] text-muted-foreground">{repo.branch}</span></li>)}
            {githubRepositories.filter(name => !repositories.some(repo => repo.path.endsWith(name))).map(name => <li key={name} className="truncate text-muted-foreground" title={name}>{name}</li>)}
          </ul>}
    </div>
    <div className={section}>
      <p className="text-[11px] font-medium text-muted-foreground">Secrets</p>
      {workspace.secretNames.length === 0
        ? <p className="text-muted-foreground">No secrets assigned.</p>
        : <p className="break-words">{workspace.secretNames.join(", ")}</p>}
    </div>
    {ports.length > 0 && <div className={section}>
      <p className="text-[11px] font-medium text-muted-foreground">Ports</p>
      <ul className="grid gap-1">{ports.map(port => <li key={port.port} className="flex items-center justify-between gap-2"><span>{port.scheme ? `${port.scheme}://` : ""}localhost:{port.hostPort ?? port.port}</span><span className="text-[11px] text-muted-foreground">{port.listening === true ? "Listening" : port.listening === false ? "Not listening" : "Unknown"}</span></li>)}</ul>
    </div>}
  </div>
}

export function SandboxDetailPage({ workspace, source, actions, controls }: {
  workspace: ApplicationWorkspace
  source: ApplicationSource
  actions: ApplicationActions
  controls: SandboxDetailControls
}) {
  const { machine } = workspace
  const target = workspaceTarget(workspace)
  const remote = Boolean(workspace.computer)
  const state = workspace.state
  const canStop = state === "running" || state === "starting"

  const access = source.sshAccess?.workspaces.find(row => row.workspace === target)
  const sshAvailable = machine.kind === "vm" && Boolean(source.sshAccess || actions.refreshSshAccess)
  const sshStale = Boolean((source.sshAccessError && !workspace.computer) || workspace.computer?.connected === false || workspace.freshness === "stale")
  const pendingSecrets = machine.kind === "vm" && !workspace.computer
    ? source.secrets.filter(secret => secret.state === "restart-required" && secret.workspaces.includes(machine.name)).map(secret => secret.name)
    : []

  const showCheckpoints = machine.kind === "vm"
  const showStorage = machine.kind === "vm" && !workspace.computer && Boolean(actions.readWorkspaceStorage)
  const showAccess = sshAvailable
  const tabs: { value: SandboxDetailTab; label: string; visible: boolean }[] = [
    { value: "overview", label: "Overview", visible: true },
    { value: "checkpoints", label: "Checkpoints", visible: showCheckpoints },
    { value: "storage", label: "Storage", visible: showStorage },
    { value: "access", label: "Access", visible: showAccess },
  ]
  const visibleTabs = tabs.filter(tab => tab.visible)
  const activeTab = visibleTabs.some(tab => tab.value === controls.activeTab) ? controls.activeTab : "overview"

  const cancelled = workspace.lifecycleFailureCancelled
  const lifecycleNotice = workspace.lifecycleFailure
    ? cancelled
      ? <div role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{cancelledActionLabel(workspace.lifecycleFailureAction ?? "start")}{controls.onRetryLifecycle && <Button size="xs" variant="outline" className="ml-2" disabled={controls.workspaceOperationBusy} onClick={controls.onRetryLifecycle}>Retry</Button>}</div>
      : <div role="alert" className="max-h-48 overflow-auto rounded-md border border-destructive/20 bg-destructive/[.06] px-3 py-2 text-xs whitespace-pre-wrap break-words text-destructive">{workspace.lifecycleFailure}{controls.onRetryLifecycle && <div className="mt-2 flex justify-end"><Button size="xs" variant="outline" disabled={controls.workspaceOperationBusy} onClick={controls.onRetryLifecycle}>Retry</Button></div>}</div>
    : null

  return <TooltipProvider delayDuration={150}>
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" className="rounded-sm hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none" onClick={controls.onBack}>Sandboxes</button>
        <ChevronRight className="size-3" aria-hidden="true" />
        <span className="truncate font-medium text-foreground" title={machine.name}>{machine.name}</span>
      </nav>

      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><ConnectionIcon kind={machine.kind} network={remote} label={machine.kind === "vm" ? `${remote ? "Remote" : "Local"} VM` : "SSH"} /></span>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-lg font-semibold" title={machine.name}>{machine.name}</h2>
          {remote && workspace.computer ? <ComputerBadge computer={workspace.computer} /> : <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground">{machine.kind}</span>}
          {pendingSecrets.length > 0 && <SecretChangesLabel workspace={machine.name} state={state} secrets={pendingSecrets} />}
          <SshAccessBadges access={access} stale={sshStale} />
        </div>
        <span className="text-xs" data-slot="sandbox-detail-status"><StatusLine workspace={workspace} source={source} readOnly={controls.readOnly} onCancel={actions.cancelOperation} /></span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Action label={`Open ${machine.name} in ${source.preferences.terminal}`} disabled={!controls.canOpen} onClick={controls.onTerminal}><Terminal /></Action>
          <Action label={`Open ${machine.name} in ${source.preferences.editor}`} disabled={!controls.canOpen} onClick={controls.onEditor}><Code /></Action>
          {canStop
            ? <Action label={`Stop ${machine.name}`} disabled={controls.readOnly || controls.configurationLocked || controls.workspaceOperationBusy || !controls.canStop} onClick={controls.onStop}><Square /></Action>
            : <Action label={`Start ${machine.name}`} disabled={controls.readOnly || controls.configurationLocked || controls.workspaceOperationBusy || !controls.canStart} onClick={controls.onStart}><Play /></Action>}
          {controls.menuActions.length > 0 && <ActionsMenu label={`More actions for ${machine.name}`} items={controls.menuActions} />}
        </div>
      </header>

      {lifecycleNotice && <div className="mt-3">{lifecycleNotice}</div>}

      <Tabs value={activeTab} onValueChange={value => controls.onSelectTab(value as SandboxDetailTab)} className="mt-4 min-h-0 flex-1">
        <TabsList variant="line" className="border-b border-border pb-0">
          {visibleTabs.map(tab => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>)}
        </TabsList>
        <ScrollArea className="min-h-0 flex-1">
          <div className="py-4">
            <TabsContent value="overview"><OverviewTab workspace={workspace} /></TabsContent>
            {showCheckpoints && <TabsContent value="checkpoints">
              <CheckpointPanel workspace={workspace} target={target} actions={actions} disabled={controls.configurationLocked || Boolean(workspace.lifecycleAction) || Boolean(workspace.computer?.busy) || workspace.freshness === "stale"} onExport={controls.onCheckpointExport} exportDisabled={controls.checkpointExportDisabled} />
            </TabsContent>}
            {showStorage && actions.readWorkspaceStorage && <TabsContent value="storage">
              <WorkspaceStoragePanel key={machine.id} workspaceId={machine.id} running={state === "running"} disabled={controls.configurationLocked || controls.workspaceOperationBusy} read={actions.readWorkspaceStorage} reclaim={actions.reclaimWorkspaceStorage} />
            </TabsContent>}
            {showAccess && <TabsContent value="access">
              <SshAccessRow embedded readOnly={controls.readOnly || controls.workspaceOperationBusy} workspace={workspace} access={access} save={actions.saveSshAccess} connection={actions.sshConnection} stale={sshStale} />
            </TabsContent>}
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  </TooltipProvider>
}

function Action({ label, children, ...props }: { label: string; children: ReactNode } & Omit<ComponentProps<typeof Button>, "children" | "aria-label">) {
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label={label} {...props}>{children}</Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}
