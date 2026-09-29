import { ChevronRight, Code, Cpu, GitBranch, Globe, KeyRound, Play, Server, Square, Terminal } from "lucide-react"
import type { ReactNode } from "react"

import { ActionsMenu, type MenuAction } from "@/components/actions-menu"
import { ListHeader, listHeadingClassName } from "@/components/list-header"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkspaceStateDot, WorkspaceStateLabel } from "@/features/application/components/application-ui"
import { CheckpointPanel } from "@/features/application/components/checkpoint-panel"
import { WorkspaceWaitingStatus } from "@/features/application/components/operation-queue-panel"
import { emptyOperationQueue, waitingOperationForVm, cancelledActionLabel } from "@/features/application/model/operation-queue"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace, SandboxDetailTab } from "@/features/application/model/application-source"
import type { WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import { SshAccessRow } from "@/features/application/pages/ssh-access-panel"
import { WorkspaceStoragePanel } from "@/features/application/pages/workspace-storage-panel"
import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"
import { cn } from "@/lib/utils"

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
  /** Opens the sandbox editor (Edit flow), reused by the Overview "Edit" action. */
  onEdit?: () => void
  onRetryLifecycle?: () => void
  // Export a checkpoint's disks; progress is shown as a background toast.
  onCheckpointExport?: (checkpoint: WorkspaceCheckpoint) => void
  checkpointExportDisabled: boolean
  // Toast a created fork (with Open) and a restored checkpoint (with Start).
  onCheckpointForked?: (name: string) => void
  onCheckpointRestored?: (checkpoint: WorkspaceCheckpoint) => void
}

const Sep = () => <span aria-hidden="true" className="mx-1">·</span>

/** The lifecycle-aware state segment that leads the detail subtitle: a state dot
 * and label, or a lifecycle/queue status while an operation is in flight. */
function StateSegment({ workspace, source, readOnly, onCancel }: { workspace: ApplicationWorkspace; source: ApplicationSource; readOnly: boolean; onCancel?: ApplicationActions["cancelOperation"] }) {
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
  return <span className="inline-flex items-center gap-1.5 align-middle">
    <WorkspaceStateDot state={state} className="size-1.5" />
    <WorkspaceStateLabel state={state} />
    {queueVmId !== null && waitingForVm && <><Sep /><WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={readOnly ? undefined : onCancel} /></>}
  </span>
}

function DetailSubtitle({ workspace, source, readOnly, pendingSecrets, sshEnabled, onCancel }: {
  workspace: ApplicationWorkspace
  source: ApplicationSource
  readOnly: boolean
  pendingSecrets: string[]
  sshEnabled: boolean
  onCancel?: ApplicationActions["cancelOperation"]
}) {
  const { machine } = workspace
  const location = workspace.computer ? workspace.computer.name : machine.kind === "vm" ? "VM" : "SSH"
  return <span>
    <StateSegment workspace={workspace} source={source} readOnly={readOnly} onCancel={onCancel} />
    <Sep />{location}
    {machine.kind === "vm" && <>
      <Sep />{machine.cpus} CPU{machine.cpus === 1 ? "" : "s"}
      <Sep />{machine.memoryGiB} GB
      <Sep />{machine.workspaceStorageGiB} GB disk
    </>}
    {pendingSecrets.length > 0 && <><Sep /><SecretChangesLabel inline workspace={machine.name} state={workspace.state} secrets={pendingSecrets} /></>}
    {sshEnabled && <><Sep /><span className="text-foreground">SSH on</span></>}
  </span>
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return <section className="grid gap-1.5">
    <div className="flex min-h-6 items-center justify-between gap-2">
      <h3 className="text-xs font-medium">{label}</h3>
      {action}
    </div>
    {children}
  </section>
}

function repositoryName(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path
}

function OverviewTab({ workspace, source, onEdit }: { workspace: ApplicationWorkspace; source: ApplicationSource; onEdit?: () => void }) {
  const { machine } = workspace
  const isVm = machine.kind === "vm"
  const repositories = workspace.repositories ?? []
  const extraGithub = (workspace.githubRepositories ?? []).filter(name => !repositories.some(repo => repo.path.endsWith(name)))
  const secretNames = workspace.secretNames ?? []
  const ports = workspace.ports ?? []
  const hasRepositories = repositories.length > 0 || extraGithub.length > 0

  const resourceTitle = isVm
    ? `${machine.cpus} CPU${machine.cpus === 1 ? "" : "s"} · ${machine.memoryGiB} GB memory · ${machine.workspaceStorageGiB} GB disk`
    : `${machine.user}@${machine.host}:${machine.port}`

  return <div className="grid gap-5">
    <Section label="Resources">
      <ListCard>
        <ListRow
          icon={<ListRowIcon aria-hidden="true">{isVm ? <Cpu className="size-3.5" /> : <Server className="size-3.5" />}</ListRowIcon>}
          title={resourceTitle}
          detail={isVm ? "Allocated to this sandbox" : "SSH machine connection"}
          actions={isVm && onEdit ? <Button type="button" variant="outline" size="xs" onClick={onEdit}>Edit</Button> : undefined}
        />
      </ListCard>
    </Section>

    <Section label="Repositories">
      <ListCard divided={repositories.length + extraGithub.length > 1}>
        {hasRepositories ? <>
          {repositories.map(repo => <ListRow
            key={repo.path}
            icon={<ListRowIcon aria-hidden="true"><GitBranch className="size-3.5" /></ListRowIcon>}
            title={<span className="truncate" title={repo.path}>{repositoryName(repo.path)}</span>}
            detail={repo.branch}
          />)}
          {extraGithub.map(name => <ListRow
            key={name}
            icon={<ListRowIcon aria-hidden="true"><GitBranch className="size-3.5" /></ListRowIcon>}
            title={<span className="truncate" title={name}>{name}</span>}
            detail="Clones on next start"
          />)}
        </> : <ListRow
          icon={<ListRowIcon aria-hidden="true"><GitBranch className="size-3.5" /></ListRowIcon>}
          title={<span className="font-normal text-muted-foreground">No repositories cloned yet.</span>}
          detail=""
        />}
      </ListCard>
    </Section>

    <Section label="Secrets">
      <ListCard divided={secretNames.length > 1}>
        {secretNames.length > 0 ? secretNames.map(name => {
          const secret = source.secrets.find(item => item.name === name)
          const detail = secret?.allowedDomains.length ? secret.allowedDomains.join(", ") : "Available in this sandbox"
          return <ListRow
            key={name}
            icon={<ListRowIcon aria-hidden="true"><KeyRound className="size-3.5" /></ListRowIcon>}
            title={<span className="truncate font-mono" title={name}>{name}</span>}
            detail={detail}
          />
        }) : <ListRow
          icon={<ListRowIcon aria-hidden="true"><KeyRound className="size-3.5" /></ListRowIcon>}
          title={<span className="font-normal text-muted-foreground">No secrets assigned.</span>}
          detail=""
        />}
      </ListCard>
    </Section>

    {ports.length > 0 && <Section label="Ports">
      <ListCard divided={ports.length > 1}>
        {ports.map(port => {
          const url = `${port.scheme ? `${port.scheme}://` : ""}localhost:${port.hostPort ?? port.port}`
          return <ListRow
            key={port.port}
            icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
            title={<span className="truncate" title={url}>{url}</span>}
            detail={<span className="inline-flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", port.listening === true ? "bg-emerald-500" : "bg-muted-foreground/50")} aria-hidden="true" />
              {port.listening === true ? "Listening" : port.listening === false ? "Not listening" : "Unknown"}
            </span>}
          />
        })}
      </ListCard>
    </Section>}
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
      ? <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span>{cancelledActionLabel(workspace.lifecycleFailureAction ?? "start")}</span>
          {controls.onRetryLifecycle && <Button size="xs" variant="outline" disabled={controls.workspaceOperationBusy} onClick={controls.onRetryLifecycle}>Retry</Button>}
        </div>
      : <div role="alert" className="grid gap-2 rounded-md border border-destructive/20 bg-destructive/[.06] px-3 py-2 text-xs text-destructive">
          <p className="max-h-40 overflow-auto break-words whitespace-pre-wrap">{workspace.lifecycleFailure}</p>
          {controls.onRetryLifecycle && <div className="flex justify-end"><Button size="xs" variant="outline" disabled={controls.workspaceOperationBusy} onClick={controls.onRetryLifecycle}>Retry</Button></div>}
        </div>
    : null

  const startStopDisabled = controls.readOnly || controls.configurationLocked || controls.workspaceOperationBusy

  return <TooltipProvider delayDuration={150}>
    <div className="flex h-full min-h-0 flex-col">
      <ListHeader
        heading={<nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
          <button type="button" className={cn(listHeadingClassName, "shrink-0 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none")} onClick={controls.onBack}>Sandboxes</button>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn(listHeadingClassName, "truncate")} title={machine.name}>{machine.name}</span>
        </nav>}
        subtitle={<span data-slot="sandbox-detail-status"><DetailSubtitle workspace={workspace} source={source} readOnly={controls.readOnly} pendingSecrets={pendingSecrets} sshEnabled={Boolean(access?.enabled)} onCancel={actions.cancelOperation} /></span>}
        actions={<div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="outline" size="xs" aria-label={`Open ${machine.name} in ${source.preferences.terminal}`} disabled={!controls.canOpen} onClick={controls.onTerminal}><Terminal aria-hidden="true" data-icon="inline-start" />Terminal</Button>
          <Button type="button" variant="outline" size="xs" aria-label={`Open ${machine.name} in ${source.preferences.editor}`} disabled={!controls.canOpen} onClick={controls.onEditor}><Code aria-hidden="true" data-icon="inline-start" />Editor</Button>
          {canStop
            ? <Button type="button" variant="outline" size="xs" aria-label={`Stop ${machine.name}`} disabled={startStopDisabled || !controls.canStop} onClick={controls.onStop}><Square aria-hidden="true" data-icon="inline-start" />Stop</Button>
            : <Button type="button" variant="outline" size="xs" aria-label={`Start ${machine.name}`} disabled={startStopDisabled || !controls.canStart} onClick={controls.onStart}><Play aria-hidden="true" data-icon="inline-start" />Start</Button>}
          {controls.menuActions.length > 0 && <ActionsMenu label={`More actions for ${machine.name}`} items={controls.menuActions} />}
        </div>}
      />

      {lifecycleNotice && <div className="mb-3">{lifecycleNotice}</div>}

      <Tabs value={activeTab} onValueChange={value => controls.onSelectTab(value as SandboxDetailTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="relative z-10 border-b border-border">
          <TabsList variant="line" className="-ml-1.5 w-fit">
            {visibleTabs.map(tab => <TabsTrigger key={tab.value} value={tab.value} className="text-xs group-data-[orientation=horizontal]/tabs:after:bottom-[-4px]">{tab.label}</TabsTrigger>)}
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="pt-4">
            <TabsContent value="overview"><OverviewTab workspace={workspace} source={source} onEdit={controls.onEdit} /></TabsContent>
            {showCheckpoints && <TabsContent value="checkpoints">
              <CheckpointPanel workspace={workspace} target={target} actions={actions} disabled={controls.configurationLocked || Boolean(workspace.lifecycleAction) || Boolean(workspace.computer?.busy) || workspace.freshness === "stale"} onExport={controls.onCheckpointExport} exportDisabled={controls.checkpointExportDisabled} onForked={controls.onCheckpointForked} onRestored={controls.onCheckpointRestored} />
            </TabsContent>}
            {showStorage && actions.readWorkspaceStorage && <TabsContent value="storage">
              <Section label="Storage">
                <ListCard>
                  <WorkspaceStoragePanel key={machine.id} workspaceId={machine.id} running={state === "running"} disabled={controls.configurationLocked || controls.workspaceOperationBusy} read={actions.readWorkspaceStorage} reclaim={actions.reclaimWorkspaceStorage} />
                </ListCard>
              </Section>
            </TabsContent>}
            {showAccess && <TabsContent value="access">
              <Section label="SSH access">
                <ListCard>
                  <SshAccessRow embedded readOnly={controls.readOnly || controls.workspaceOperationBusy} workspace={workspace} access={access} save={actions.saveSshAccess} connection={actions.sshConnection} stale={sshStale} />
                </ListCard>
              </Section>
            </TabsContent>}
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  </TooltipProvider>
}
