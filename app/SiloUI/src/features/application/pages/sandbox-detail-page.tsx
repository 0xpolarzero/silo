import { ChevronRight, Code, CopyPlus, Cpu, GitBranch, Globe, KeyRound, Pencil, Play, Plus, Server, Square, Terminal, Trash2 } from "lucide-react"
import { useId, type MouseEvent, type ReactNode } from "react"

import { ActionsMenu, type MenuAction, type MenuPopovers } from "@/components/actions-menu"
import { ConfirmBody } from "@/components/confirm-popover"
import { ListHeader, listHeadingClassName } from "@/components/list-header"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { MachineEditor } from "@/features/sandboxes/components/machine-editor"
import { useMachineEditing } from "@/features/sandboxes/model/use-machine-editing"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import { CheckpointPanel } from "@/features/application/components/checkpoint-panel"
import { WorkspaceWaitingStatus } from "@/features/application/components/operation-queue-panel"
import { emptyOperationQueue, waitingOperationForVm } from "@/features/application/model/operation-queue"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace, SandboxDetailTab, SshAccessWorkspace } from "@/features/application/model/application-source"
import type { WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import { SshAccessBadges, SshAccessRow } from "@/features/application/pages/ssh-access-panel"
import { WorkspaceStoragePanel } from "@/features/application/pages/workspace-storage-panel"
import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"
import { AddSecretEditor, SecretRow, useSecretsManager } from "@/features/application/components/secrets-management"
import { NetworkPortForm, NetworkPortRowActions, networkAddress, networkPortState, useNetworkPorts } from "@/features/application/components/network-ports"
import { cn } from "@/lib/utils"

/** Everything the detail page needs to edit or delete this sandbox in place, sharing the
 * list's `useMachineEditing` behaviour (validation, stale-baseline conflict review, saving). */
export interface SandboxDetailEditing {
  machines: readonly SetupMachineConfiguration[]
  computers?: readonly { id: string; name: string; connected: boolean }[]
  getComputerId?: (machine: SetupMachineConfiguration) => string | undefined
  onCommitMachine?: (machine: SetupMachineConfiguration, original: SetupMachineConfiguration | undefined, computerId: string, baseline?: SetupMachineConfiguration[]) => Promise<void>
  onDeleteMachine?: (machine: SetupMachineConfiguration, baseline?: SetupMachineConfiguration[]) => Promise<void>
  onMachinesChange: (machines: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[]) => Promise<void> | void
  validateOperation?: (machine: SetupMachineConfiguration, isNew: boolean, computerId?: string) => string | undefined
  isMachineCreated?: (machine: SetupMachineConfiguration) => boolean
  isMachineRunning?: (machine: SetupMachineConfiguration) => boolean
}

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
  /** Popovers opened by `menuActions` entries with a matching `popover` key (e.g. Fork), anchored to the ⋯ button. */
  popovers?: MenuPopovers
  onTerminal: () => void
  onEditor: () => void
  onStart: () => void
  onStop: () => void
  /** In-place Edit/Delete of this sandbox. Absent in read-only or standalone renders. */
  editing?: SandboxDetailEditing
  /** Duplicate opens the list editor for the new sandbox (it leaves the detail page). */
  onDuplicate?: () => void
  /** Jump to another section (Files/Network filtered to this sandbox, or the Secrets tab). */
  onNavigate?: (route: ApplicationInitialRoute) => void
  onRetryLifecycle?: () => void
  // Export a checkpoint's disks; progress is shown as a background toast.
  onCheckpointExport?: (checkpoint: WorkspaceCheckpoint) => void
  checkpointExportDisabled: boolean
  // Toast a created fork (with Open) and a restored checkpoint (with Start).
  onCheckpointForkedAction?: (name: string) => { label: string; onClick: () => void }
  onCheckpointRestoredAction?: (checkpoint: WorkspaceCheckpoint) => { label: string; onClick: () => void }
}

const Sep = () => <span aria-hidden="true" className="mx-1">·</span>

/** The lifecycle-aware state segment that leads the detail subtitle: a state
 * label, or a lifecycle/queue status while an operation is in flight. */
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
    <WorkspaceStateLabel state={state} />
    {queueVmId !== null && waitingForVm && <><Sep /><WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={readOnly ? undefined : onCancel} /></>}
  </span>
}

function DetailSubtitle({ workspace, source, readOnly, pendingSecrets, sshAccess, sshStale, onCancel }: {
  workspace: ApplicationWorkspace
  source: ApplicationSource
  readOnly: boolean
  pendingSecrets: string[]
  sshAccess?: SshAccessWorkspace
  sshStale: boolean
  onCancel?: ApplicationActions["cancelOperation"]
}) {
  const { machine } = workspace
  const location = workspace.computer ? workspace.computer.name : machine.kind === "vm" ? "VM" : "SSH"
  return <span>
    <StateSegment workspace={workspace} source={source} readOnly={readOnly} onCancel={onCancel} />
    <Sep />{location}
    {pendingSecrets.length > 0 && <><Sep /><SecretChangesLabel inline workspace={machine.name} state={workspace.state} secrets={pendingSecrets} /></>}
    {sshAccess?.enabled && <><Sep /><SshAccessBadges access={sshAccess} stale={sshStale} /></>}
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

/** A right-aligned link that jumps to the section this data is managed in, scoped to the
 * sandbox where applicable. Shown even when the section is empty — it is still the place
 * to manage it. */
function ViewAllAction({ label, onClick }: { label: string; onClick: () => void }) {
  return <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-[11px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
  >
    View all<ChevronRight className="size-3" aria-hidden="true" />
  </button>
}

/** A small ghost xs action that fits the section header row, paired with the View all link. */
function AddAction({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return <Button type="button" variant="ghost" size="xs" aria-label={label} disabled={disabled} onClick={onClick}>
    <Plus aria-hidden="true" data-icon="inline-start" />Add
  </Button>
}

/** The Secrets section, scoped to this sandbox: assigned secrets with the same row states,
 * inline editor, and remove confirmation as the Secrets page. Add preselects this sandbox.
 * Only local VMs support secrets, so remote and SSH sandboxes stay read-only. */
function SecretsSection({ workspace, source, actions, onNavigate }: { workspace: ApplicationWorkspace; source: ApplicationSource; actions: ApplicationActions; onNavigate?: (route: ApplicationInitialRoute) => void }) {
  const { machine } = workspace
  const canManage = machine.kind === "vm" && !workspace.computer
  const manager = useSecretsManager({ source, onSaveSecret: actions.saveSecret, onRemoveSecret: actions.removeSecret, onRetrySecret: actions.retrySecret })
  const sandboxSecrets = source.secrets.filter(secret => secret.workspaces.includes(machine.name))
  const adding = Boolean(manager.editor && !manager.editor.secret)

  const action = <div className="flex items-center gap-2">
    {canManage && <AddAction label="Add secret" disabled={manager.saving || manager.busy !== null} onClick={(event) => manager.openEditor(event.currentTarget, { initialWorkspaces: [machine.name] })} />}
    {onNavigate && <ViewAllAction label="View all secrets" onClick={() => onNavigate({ tab: "secrets" })} />}
  </div>

  return <Section label="Secrets" action={action}>
    <ListCard>
      {adding && <div className="border-b border-border"><AddSecretEditor manager={manager} /></div>}
      {canManage && sandboxSecrets.length > 0
        ? <ul className="divide-y divide-border" aria-label={`Secrets for ${machine.name}`}>{sandboxSecrets.map(secret => <SecretRow key={secret.id} secret={secret} manager={manager} />)}</ul>
        : sandboxSecrets.length > 0
          ? <div className="divide-y divide-border">{sandboxSecrets.map(secret => <ListRow
              key={secret.id}
              icon={<ListRowIcon aria-hidden="true"><KeyRound className="size-3.5" /></ListRowIcon>}
              title={<span className="truncate font-mono" title={secret.name}>{secret.name}</span>}
              detail={secret.allowedDomains.length ? secret.allowedDomains.join(", ") : "Available in this sandbox"}
            />)}</div>
          : !adding && <ListRow
              icon={<ListRowIcon aria-hidden="true"><KeyRound className="size-3.5" /></ListRowIcon>}
              title={<span className="font-normal text-muted-foreground">No secrets assigned.</span>}
              detail=""
            />}
    </ListCard>
  </Section>
}

const inlinePortFormClassName = "grid grid-cols-2 items-end gap-2 p-3 sm:grid-cols-[6rem_minmax(0,1fr)_8rem_auto] sm:gap-3"

/** The Ports section, scoped to this sandbox and backed by the same live network data as the
 * Network page. Add/edit/remove/open reuse the Network page's form, confirmation, and actions.
 * Falls back to the workspace's cached ports only when live network data is absent. */
function PortsSection({ workspace, source, actions, browser, active, onNavigate }: { workspace: ApplicationWorkspace; source: ApplicationSource; actions: ApplicationActions; browser: string; active: boolean; onNavigate?: (route: ApplicationInitialRoute) => void }) {
  const { machine } = workspace
  const target = workspaceTarget(workspace)
  const fieldID = useId()
  const useLive = source.network !== undefined
  const controller = useNetworkPorts({ workspaces: [workspace], network: source.network, error: source.networkError, actions, active })
  const { draft, rows } = controller
  const fallbackPorts = workspace.ports ?? []
  const canAdd = Boolean(actions.saveNetworkPort) && controller.localWorkspaces.length > 0
  const inlineForm = <NetworkPortForm controller={controller} fieldID={fieldID} hideSandbox className={inlinePortFormClassName} />

  const action = <div className="flex items-center gap-2">
    {canAdd && (controller.addDisabledReason
      ? <Tooltip><TooltipTrigger asChild><span tabIndex={0}><AddAction label="Add port" disabled onClick={() => undefined} /></span></TooltipTrigger><TooltipContent>{controller.addDisabledReason}</TooltipContent></Tooltip>
      : <AddAction label="Add port" disabled={controller.busy} onClick={() => controller.add(target)} />)}
    {onNavigate && <ViewAllAction label="View all network for this sandbox" onClick={() => onNavigate({ workspaceSection: "network", workspace: machine.id })} />}
  </div>

  return <Section label="Ports" action={action}>
    {(controller.error || controller.errors.length > 0) && <div role="alert" className="mb-2 flex items-center justify-between gap-3 rounded-md border border-destructive/20 px-3 py-2 text-xs text-destructive">
      <span>{controller.error || controller.errors.join(" · ")}</span>
      {actions.refreshNetwork && <Button size="sm" variant="ghost" onClick={() => void actions.refreshNetwork?.()}>Retry</Button>}
    </div>}
    <ListCard>
      {draft && !draft.editing && <div className="border-b border-border">{inlineForm}</div>}
      {useLive
        ? rows.length > 0
          ? <div className="divide-y divide-border">{rows.map(({ workspace: portWorkspace, port }) => {
              const key = `${target}:${port.port}`
              if (draft?.editing && draft.port === String(port.port)) return <div key={key} className="last:*:border-b-0">{inlineForm}</div>
              const address = networkAddress(port)
              const stateText = networkPortState(portWorkspace, port, controller.error, controller.errors)
              return <ListRow
                key={key}
                icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
                title={<span className="truncate font-mono" title={address ? `${port.port} → ${address}` : `VM port ${port.port}`}>{address ? `${port.port} → ${address}` : `VM port ${port.port}`}</span>}
                detailClassName="whitespace-normal"
                detail={<span className="inline-flex flex-wrap items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", stateText === "Reachable" ? "bg-emerald-500" : "bg-muted-foreground/50")} aria-hidden="true" />
                  <span className={stateText === "Reachable" ? "text-emerald-700 dark:text-emerald-400" : undefined}>{stateText}</span>
                  {port.message && <span className={port.state === "unknown" ? "text-destructive" : "text-muted-foreground"}>· {port.message}</span>}
                </span>}
                actions={<div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                  <NetworkPortRowActions controller={controller} workspace={portWorkspace} port={port} state={stateText} browser={browser} />
                </div>}
              />
            })}</div>
          : !draft && <ListRow
              icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
              title={<span className="font-normal text-muted-foreground">No forwarded ports.</span>}
              detail=""
            />
        : fallbackPorts.length > 0
          ? <div className="divide-y divide-border">{fallbackPorts.map(port => {
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
            })}</div>
          : <ListRow
              icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
              title={<span className="font-normal text-muted-foreground">No forwarded ports.</span>}
              detail=""
            />}
    </ListCard>
  </Section>
}

function OverviewTab({ workspace, source, actions, active, onEdit, onNavigate }: { workspace: ApplicationWorkspace; source: ApplicationSource; actions: ApplicationActions; active: boolean; onEdit?: () => void; onNavigate?: (route: ApplicationInitialRoute) => void }) {
  const { machine } = workspace
  const isVm = machine.kind === "vm"
  const repositories = workspace.repositories ?? []
  const extraGithub = (workspace.githubRepositories ?? []).filter(name => !repositories.some(repo => repo.path.endsWith(name)))
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

    <Section label="Repositories" action={onNavigate ? <ViewAllAction label="View all files for this sandbox" onClick={() => onNavigate({ workspaceSection: "files", workspace: machine.id })} /> : undefined}>
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

    <SecretsSection workspace={workspace} source={source} actions={actions} onNavigate={onNavigate} />

    <PortsSection workspace={workspace} source={source} actions={actions} browser={source.preferences.browser} active={active} onNavigate={onNavigate} />
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

  // The detail page edits and deletes this sandbox in place using the same flow as the list.
  const editingContext = controls.editing
  const editing = useMachineEditing({
    machines: editingContext?.machines ?? [machine],
    getComputerId: editingContext?.getComputerId,
    onCommitMachine: editingContext?.onCommitMachine,
    onDeleteMachine: editingContext?.onDeleteMachine,
    onMachinesChange: editingContext?.onMachinesChange ?? (() => {}),
    validateOperation: editingContext?.validateOperation,
    isMachineRunning: editingContext?.isMachineRunning,
    interactionDisabled: controls.configurationLocked,
  })
  const canEdit = Boolean(editingContext) && !controls.configurationLocked
  const isEditing = Boolean(editing.editor)
  const editComputerMachines = editingContext?.getComputerId
    ? (editingContext.machines).filter(item => (editingContext.getComputerId!(item) ?? "") === editing.computerId)
    : (editingContext?.machines ?? [machine])

  const editMenuActions: MenuAction[] = editingContext ? [
    { label: "Edit", separatorBefore: controls.menuActions.length > 0, icon: Pencil, accessibleLabel: `Edit ${machine.name}`, disabled: controls.configurationLocked, onSelect: () => editing.startEdit(machine) },
    { label: "Duplicate", icon: CopyPlus, accessibleLabel: `Duplicate ${machine.name}`, disabled: controls.configurationLocked || !controls.onDuplicate, onSelect: () => controls.onDuplicate?.() },
    { label: "Delete", icon: Trash2, destructive: true, accessibleLabel: `Delete ${machine.name}`, disabled: controls.configurationLocked || (machine.kind === "vm" && state === "running"), popover: "delete" },
  ] : []
  const menuActions = [...controls.menuActions, ...editMenuActions]

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
    { value: "access", label: "SSH", visible: showAccess },
  ]
  const visibleTabs = tabs.filter(tab => tab.visible)
  const deleteTitle = `Delete ${workspace.computer ? `${machine.name} on ${workspace.computer.name}` : machine.name}?`
  const menuPopovers: MenuPopovers = {
    ...controls.popovers,
    delete: close => <ConfirmBody
      tone="destructive"
      title={deleteTitle}
      description={`Removing ${machine.name} from Silo. Persistent volumes are kept.`}
      confirmLabel="Delete"
      onClose={close}
      onConfirm={async () => {
        if (await editing.deleteWithNotice(machine)) controls.onBack()
      }}
    />,
  }
  const menu = <ActionsMenu label={`More actions for ${machine.name}`} items={menuActions} popovers={menuPopovers} />
  const activeTab = visibleTabs.some(tab => tab.value === controls.activeTab) ? controls.activeTab : "overview"

  const startStopDisabled = controls.readOnly || controls.configurationLocked || controls.workspaceOperationBusy

  return <TooltipProvider delayDuration={150}>
    <div className="flex h-full min-h-0 flex-col">
      <ListHeader
        heading={<nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
          <button type="button" className={cn(listHeadingClassName, "shrink-0 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none")} onClick={controls.onBack}>Sandboxes</button>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn(listHeadingClassName, "truncate")} title={machine.name}>{machine.name}</span>
        </nav>}
        subtitle={<span data-slot="sandbox-detail-status"><DetailSubtitle workspace={workspace} source={source} readOnly={controls.readOnly} pendingSecrets={pendingSecrets} sshAccess={access} sshStale={sshStale} onCancel={actions.cancelOperation} /></span>}
        actions={<div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="outline" size="xs" aria-label={`Open ${machine.name} in ${source.preferences.terminal}`} disabled={!controls.canOpen} onClick={controls.onTerminal}><Terminal aria-hidden="true" data-icon="inline-start" />Terminal</Button>
          <Button type="button" variant="outline" size="xs" aria-label={`Open ${machine.name} in ${source.preferences.editor}`} disabled={!controls.canOpen} onClick={controls.onEditor}><Code aria-hidden="true" data-icon="inline-start" />Editor</Button>
          {canStop
            ? <Button type="button" variant="outline" size="xs" aria-label={`Stop ${machine.name}`} disabled={startStopDisabled || !controls.canStop} onClick={controls.onStop}><Square aria-hidden="true" data-icon="inline-start" />Stop</Button>
            : <Button type="button" variant="outline" size="xs" aria-label={`Start ${machine.name}`} disabled={startStopDisabled || !controls.canStart} onClick={controls.onStart}><Play aria-hidden="true" data-icon="inline-start" />Start</Button>}
          {menuActions.length > 0 && menu}
        </div>}
      />

      {isEditing && editing.editor ? (
        <ScrollArea className="min-h-0 flex-1">
          <Section label={`Edit ${machine.name}`}>
            <div className="rounded-lg border border-border bg-background">
              <MachineEditor
                key={`${editing.editor.draft.id}:${editing.editorResetToken}`}
                saving={editing.committing}
                editorHeader={editingContext?.computers && editing.editor.draft.kind === "vm" ? <label className="grid gap-1 text-[11px] text-muted-foreground">Run on<select aria-label="Run on" className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground" value={editing.computerId} disabled={Boolean(editing.editor.originalID) || editing.committing} onChange={event => editing.setComputerId(event.target.value)}><option value="">This computer</option>{editingContext.computers.map(computer => <option key={computer.id} value={computer.id} disabled={!computer.connected}>{computer.name}{!computer.connected ? " (unavailable)" : ""}</option>)}</select></label> : undefined}
                focusRequest={editing.editorFocusRequest}
                created={Boolean(editing.editor.originalID && editingContext?.isMachineCreated?.(machine))}
                running={Boolean(editing.editor.originalID && machine.kind === "vm" && editingContext?.isMachineRunning?.(machine))}
                editor={editing.editor}
                baselineMachine={editing.editorBaseline ?? undefined}
                conflict={editing.editorConflict}
                machines={editComputerMachines}
                onCancel={() => editing.setEditor(null)}
                onSave={editing.save}
                onDraftChange={(draft) => editing.setEditor({ ...editing.editor!, draft })}
                onReview={editing.reviewConflict}
                onDiscard={() => editing.setEditor(null)}
              />
            </div>
          </Section>
        </ScrollArea>
      ) : (
      <Tabs value={activeTab} onValueChange={value => controls.onSelectTab(value as SandboxDetailTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="relative z-10 border-b border-border">
          <TabsList variant="line" className="-ml-1.5 w-fit">
            {visibleTabs.map(tab => <TabsTrigger key={tab.value} value={tab.value} className="text-xs group-data-[orientation=horizontal]/tabs:after:bottom-[-4px]">{tab.label}</TabsTrigger>)}
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="pt-4">
            <TabsContent value="overview"><OverviewTab workspace={workspace} source={source} actions={actions} active={activeTab === "overview"} onEdit={canEdit ? () => editing.startEdit(machine) : undefined} onNavigate={controls.onNavigate} /></TabsContent>
            {showCheckpoints && <TabsContent value="checkpoints">
              <CheckpointPanel workspace={workspace} target={target} actions={actions} disabled={controls.configurationLocked || Boolean(workspace.lifecycleAction) || Boolean(workspace.computer?.busy) || workspace.freshness === "stale"} onExport={controls.onCheckpointExport} exportDisabled={controls.checkpointExportDisabled} forkedAction={controls.onCheckpointForkedAction} restoredAction={controls.onCheckpointRestoredAction} />
            </TabsContent>}
            {showStorage && actions.readWorkspaceStorage && <TabsContent value="storage">
              <WorkspaceStoragePanel key={machine.id} workspaceId={machine.id} sandboxName={machine.name} computerName={workspace.computer?.name} running={state === "running"} disabled={controls.configurationLocked || controls.workspaceOperationBusy} read={actions.readWorkspaceStorage} reclaim={actions.reclaimWorkspaceStorage} />
            </TabsContent>}
            {showAccess && <TabsContent value="access">
              <SshAccessRow embedded readOnly={controls.readOnly || controls.workspaceOperationBusy} workspace={workspace} access={access} save={actions.saveSshAccess} connection={actions.sshConnection} stale={sshStale} />
            </TabsContent>}
          </div>
        </ScrollArea>
      </Tabs>
      )}
    </div>
  </TooltipProvider>
}
