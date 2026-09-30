import { ChevronRight, Code, Cpu, GitBranch, Globe, KeyRound, Play, Plus, RotateCw, Server, Square, Terminal, TriangleAlert } from "lucide-react"
import { useId, type MouseEvent, type ReactNode } from "react"

import { ActionsMenu, type MenuAction, type MenuPopovers } from "@/components/actions-menu"
import { ListHeader, listHeadingClassName } from "@/components/list-header"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { MachineEditor } from "@/features/sandboxes/components/machine-editor"
import { useMachineEditing } from "@/features/sandboxes/model/use-machine-editing"
import { sandboxBusyReason } from "@/features/sandboxes/model/workspace-presentation"
import { hostCapacityFrom } from "@/features/sandboxes/model/machine-limits"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { DeleteSandboxBody, type DeleteSandboxDetails } from "@/features/sandboxes/components/delete-sandbox-confirmation"
import { sandboxEditMenu } from "@/features/sandboxes/model/sandbox-edit-menu"
import { CheckpointPanel } from "@/features/application/components/checkpoint-panel"
import { StatusSeparator, WorkspaceStatus } from "@/features/application/components/workspace-status"
import { DisabledReason } from "@/features/application/components/disabled-reason"
import { LifecycleControl } from "@/features/application/components/lifecycle-control"
import { AccountMigrationNotice } from "@/features/application/components/account-migration"
import type { LifecycleGuard } from "@/features/application/model/lifecycle-guard"
import type { AccountMigrationPlan, NetworkPort, ApplicationActions, ApplicationSource, ApplicationWorkspace, SandboxDetailTab, SshAccessWorkspace } from "@/features/application/model/application-source"
import { sandboxNamesOnComputer, type WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"
import { SshAccessBadges, SshAccessRow } from "@/features/application/pages/ssh-access-panel"
import { WorkspaceStoragePanel } from "@/features/application/pages/workspace-storage-panel"
import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"
import { AddSecretEditor, SecretRow } from "@/features/application/components/secrets-management"
import { useSecretsManager } from "@/features/application/components/secrets-manager"
import { NetworkPortForm, NetworkPortRowActions } from "@/features/application/components/network-ports"
import { networkAddress, networkPortState, useNetworkPorts } from "@/features/application/components/network-ports-state"
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
  /** Whether the page holding this sandbox is visible; background refresh stops while it is not. Default true. */
  pageActive?: boolean
  onBack: () => void
  activeTab: SandboxDetailTab
  onSelectTab: (tab: SandboxDetailTab) => void
  readOnly: boolean
  configurationLocked: boolean
  workspaceOperationBusy: boolean
  /** Edit, Duplicate, Add Linux desktop and Delete wait while work runs or the computer is offline. */
  changesBlocked?: boolean
  canOpen: boolean
  canStart: boolean
  canStop: boolean
  /** Why Open, Start or Stop is unavailable, shown on the disabled control. */
  disabledReasons?: { open?: string; start?: string; stop?: string }
  menuActions: MenuAction[]
  /** Popovers opened by `menuActions` entries with a matching `popover` key (e.g. Fork), anchored to the ⋯ button. */
  popovers?: MenuPopovers
  onTerminal: () => void
  onEditor: () => void
  /** Start and Stop go through the shared lifecycle guard; its prompts open next to the button. */
  lifecycleGuard: LifecycleGuard
  /** In-place Edit/Delete of this sandbox. Absent in read-only or standalone renders. */
  editing?: SandboxDetailEditing
  /** Opens a ⋯ popover (Fork, Delete) without the menu, for a command palette request. */
  menuRequest?: { token: number; panel: string }
  /** What the Delete dialog states (checkpoints, size) and offers, as from the list row. */
  deleteDetails?: DeleteSandboxDetails
  /** Duplicate opens the list editor for the new sandbox (it leaves the detail page). */
  onDuplicate?: () => void
  /** Jump to another section (Files/Network filtered to this sandbox, or the Secrets tab). */
  onNavigate?: (route: ApplicationInitialRoute) => void
  // Export a checkpoint's disks; progress is shown as a background toast.
  onCheckpointExport?: (checkpoint: WorkspaceCheckpoint) => void
  checkpointExportDisabled: boolean
  // Toast a created fork (with Open) and a restored checkpoint (with Start).
  onCheckpointForkedAction?: (name: string) => { label: string; onClick: () => void }
  onCheckpointRestoredAction?: (checkpoint: WorkspaceCheckpoint) => { label: string; onClick: () => void }
  /** Present while the sandbox uses the old account layout: its dry run and migration. */
  accountMigration?: {
    /** Why migration cannot be requested right now. */
    disabledReason?: string
    plan: () => Promise<AccountMigrationPlan>
    migrate: () => Promise<unknown>
  }
}

const Sep = StatusSeparator

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
  const location = workspace.computer ? workspace.computer.name : machine.kind === "vm" ? "VM" : "SSH host"
  return <span>
    <WorkspaceStatus workspace={workspace} source={source} readOnly={readOnly} onCancel={onCancel} />
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
 * Only local sandboxes support secrets, so remote and SSH sandboxes stay read-only. */
function SecretsSection({ workspace, source, actions, onNavigate }: { workspace: ApplicationWorkspace; source: ApplicationSource; actions: ApplicationActions; onNavigate?: (route: ApplicationInitialRoute) => void }) {
  const { machine } = workspace
  const canManage = machine.kind === "vm" && !workspace.computer
  const manager = useSecretsManager({ source, onSaveSecret: actions.saveSecret, onRemoveSecret: actions.removeSecret, onRetrySecret: actions.retrySecret })
  // Secret assignments name local sandboxes, so a remote or SSH sandbox never lists them.
  const sandboxSecrets = canManage ? source.secrets.filter(secret => secret.workspaces.includes(machine.name)) : []
  const adding = Boolean(manager.editor && !manager.editor.secret)

  if (!canManage) return <Section label="Secrets">
    <p className="text-xs text-muted-foreground">Secrets are available only for sandboxes on this computer.</p>
  </Section>

  const action = <div className="flex items-center gap-2">
    <AddAction label="Add secret" disabled={manager.saving || manager.busy !== null} onClick={(event) => manager.openEditor(event.currentTarget, { initialWorkspaces: [machine.name] })} />
    {onNavigate && <ViewAllAction label="View all secrets" onClick={() => onNavigate({ tab: "secrets" })} />}
  </div>

  return <Section label="Secrets" action={action}>
    <ListCard>
      {adding && <div className="border-b border-border"><AddSecretEditor manager={manager} /></div>}
      {sandboxSecrets.length > 0
        ? <ul className="divide-y divide-border" aria-label={`Secrets for ${machine.name}`}>{sandboxSecrets.map(secret => <SecretRow key={secret.id} secret={secret} manager={manager} />)}</ul>
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
          ? <div className="divide-y divide-border">{rows.map(({ workspace: portWorkspace, port, host }) => {
              const key = `${target}:${port.port}`
              if (draft?.editing && draft.port === String(port.port)) return <div key={key} className="last:*:border-b-0">{inlineForm}</div>
              const address = networkAddress(port, host)
              const stateText = networkPortState(portWorkspace, port, controller.error, controller.errors)
              return <ListRow
                key={key}
                icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
                title={<span className="truncate font-mono" title={address ? `${port.port} → ${address}` : `Port ${port.port}`}>{address ? `${port.port} → ${address}` : `Port ${port.port}`}</span>}
                detailClassName="whitespace-normal"
                detail={<span className="inline-flex flex-wrap items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", stateText === "Reachable" ? "bg-emerald-500" : "bg-muted-foreground/50")} aria-hidden="true" />
                  <span className={stateText === "Reachable" ? "text-emerald-700 dark:text-emerald-400" : undefined}>{stateText}</span>
                  {port.message && <span className={port.state === "unknown" ? "text-destructive" : "text-muted-foreground"}>· {port.message}</span>}
                </span>}
                actions={<div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                  <NetworkPortRowActions controller={controller} workspace={portWorkspace} port={port} state={stateText} browser={browser} host={host} />
                </div>}
              />
            })}</div>
          : !draft && <ListRow
              icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
              title={<span className="font-normal text-muted-foreground">No ports</span>}
              detail=""
            />
        : fallbackPorts.length > 0
          ? <div className="divide-y divide-border">{fallbackPorts.map(port => {
              const cachedPort: NetworkPort = {
                ...port, hostPort: port.hostPort ?? null, scheme: port.scheme ?? null,
                configured: port.configured ?? false,
                state: port.hostPort == null || port.configured === false ? "unpublished" : port.listening === true ? "reachable" : port.listening === false ? "waiting" : "unknown",
              }
              const address = networkAddress(cachedPort)
              const stateText = networkPortState(workspace, cachedPort)
              const title = address ?? `Port ${port.port}`
              return <ListRow
                key={port.port}
                icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
                title={<span className="truncate" title={title}>{title}</span>}
                detail={<span className="inline-flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", stateText === "Reachable" ? "bg-emerald-500" : "bg-muted-foreground/50")} aria-hidden="true" />
                  {stateText}
                </span>}
              />
            })}</div>
          : <ListRow
              icon={<ListRowIcon aria-hidden="true"><Globe className="size-3.5" /></ListRowIcon>}
              title={<span className="font-normal text-muted-foreground">No ports</span>}
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
    ? `CPUs: ${machine.cpus} · Memory: ${machine.memoryGiB} GiB · Disk: ${machine.workspaceStorageGiB} GiB`
    : `${machine.user}@${machine.host}:${machine.port}`

  return <div className="grid gap-5">
    <Section label="Resources">
      <ListCard>
        <ListRow
          icon={<ListRowIcon aria-hidden="true">{isVm ? <Cpu className="size-3.5" /> : <Server className="size-3.5" />}</ListRowIcon>}
          title={resourceTitle}
          detail={isVm ? "Allocated to this sandbox" : "SSH host connection"}
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
  // A starting or stopping VM can be neither edited nor deleted until it settles.
  const busyReason = sandboxBusyReason(workspace)

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
    getMachineBusyReason: (item) => item.id === machine.id ? busyReason : undefined,
    // Leaving the page (⌘1–7, ⌘[, the breadcrumb) and returning restores an unsaved edit.
    draftKey: `sandbox-detail:${machine.id}`,
  })
  const canEdit = Boolean(editingContext) && !controls.configurationLocked && !busyReason
  const isEditing = Boolean(editing.editor)
  const editComputerMachines = editingContext?.getComputerId
    ? (editingContext.machines).filter(item => (editingContext.getComputerId!(item) ?? "") === editing.computerId)
    : (editingContext?.machines ?? [machine])

  const displayName = workspace.computer ? `${machine.name} on ${workspace.computer.name}` : machine.name
  const editMenuActions: MenuAction[] = editingContext ? sandboxEditMenu({
    machine,
    displayName,
    disabled: controls.configurationLocked || editing.interactionDisabled || Boolean(controls.changesBlocked),
    busyReason,
    created: Boolean(editingContext.isMachineCreated?.(machine)),
    running: state === "running",
    separatorBefore: controls.menuActions.length > 0,
    onEdit: () => editing.startEdit(machine),
    onDuplicate: controls.onDuplicate,
    onAddDesktop: (vm) => {
      editing.beginOperation()
      editing.captureBaseline()
      void editing.save({ ...vm, desktop: { startWithSandbox: true } }, machine.id, editingContext.getComputerId?.(machine) ?? "")
    },
  }) : []
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
    { value: "access", label: "SSH access", visible: showAccess },
  ]
  const visibleTabs = tabs.filter(tab => tab.visible)
  const menuPopovers: MenuPopovers = {
    ...controls.popovers,
    delete: close => <DeleteSandboxBody
      kind={machine.kind}
      displayName={displayName}
      details={controls.deleteDetails}
      onClose={close}
      onDelete={async () => {
        if (await editing.deleteWithNotice(machine)) controls.onBack()
      }}
    />,
  }
  const menu = <ActionsMenu label={`More actions for ${machine.name}`} items={menuActions} popovers={menuPopovers} openPanel={controls.menuRequest} />
  const activeTab = visibleTabs.some(tab => tab.value === controls.activeTab) ? controls.activeTab : "overview"

  const reasons = controls.disabledReasons ?? {}
  const restartAvailability = workspaceAvailability(workspace, source)

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
          <DisabledReason reason={controls.canOpen ? undefined : reasons.open}><Button type="button" variant="outline" size="xs" aria-label={`Open ${machine.name} in ${source.preferences.terminal}`} disabled={!controls.canOpen} onClick={controls.onTerminal}><Terminal aria-hidden="true" data-icon="inline-start" />Terminal</Button></DisabledReason>
          <DisabledReason reason={controls.canOpen ? undefined : reasons.open}><Button type="button" variant="outline" size="xs" aria-label={`Open ${machine.name} in ${source.preferences.editor}`} disabled={!controls.canOpen} onClick={controls.onEditor}><Code aria-hidden="true" data-icon="inline-start" />Editor</Button></DisabledReason>
          {canStop
            ? <LifecycleControl guard={controls.lifecycleGuard} workspace={workspace} action="stop" disabled={!controls.canStop} reason={reasons.stop}>
              {({ onClick, disabled }) => <Button type="button" variant="outline" size="xs" aria-label={`Stop ${machine.name}`} disabled={disabled} onClick={onClick}><Square aria-hidden="true" data-icon="inline-start" />{!disabled && controls.lifecycleGuard.check(workspace, "stop").kind === "confirm" ? "Stop…" : "Stop"}</Button>}
            </LifecycleControl>
            : <LifecycleControl guard={controls.lifecycleGuard} workspace={workspace} action="start" disabled={!controls.canStart} reason={reasons.start}>
              {({ onClick, disabled }) => <Button type="button" variant="outline" size="xs" aria-label={`Start ${machine.name}`} disabled={disabled} onClick={onClick}><Play aria-hidden="true" data-icon="inline-start" />{!disabled && controls.lifecycleGuard.check(workspace, "start").kind === "confirm" ? "Start…" : "Start"}</Button>}
            </LifecycleControl>}
          {menuActions.length > 0 && menu}
        </div>}
      />

      <AccountMigrationNotice
        workspace={workspace}
        disabled={Boolean(controls.accountMigration?.disabledReason)}
        disabledReason={controls.accountMigration?.disabledReason}
        plan={controls.accountMigration?.plan}
        onMigrate={controls.accountMigration?.migrate}
        onRetry={controls.accountMigration ? () => { void controls.accountMigration!.migrate() } : undefined}
      />

      {Boolean(workspace.pendingSecretRevocations?.length) && <div role="note" aria-label="Pending secret revocation" className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 break-words">May still have access to {workspace.pendingSecretRevocations!.join(", ")} until it restarts.</p>
        <LifecycleControl guard={controls.lifecycleGuard} workspace={workspace} action="restart" disabled={controls.readOnly || !restartAvailability.canRestart} reason={controls.readOnly ? undefined : restartAvailability.reasons.restart}>
          {({ onClick, disabled }) => <Button variant="outline" size="xs" aria-label={`Restart ${machine.name}`} disabled={disabled} onClick={onClick}><RotateCw aria-hidden="true" />Restart</Button>}
        </LifecycleControl>
      </div>}

      {isEditing && editing.editor ? (
        <ScrollArea className="min-h-0 flex-1">
          <Section label={`Edit ${machine.name}`}>
            <div className="rounded-lg border border-border bg-background">
              <MachineEditor
                key={`${editing.editor.draft.id}:${editing.editorResetToken}`}
                saving={editing.committing}
                blockedReason={editing.saveBlockedReason}
                capacity={editing.computerId ? undefined : hostCapacityFrom(source.hostCapacity)}
                computerName={workspace.computer?.name}
                editorHeader={editingContext?.computers && editing.editor.draft.kind === "vm" ? <label className="grid gap-1 text-[11px] text-muted-foreground">Run on<select aria-label="Run on" className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground" value={editing.computerId} disabled={Boolean(editing.editor.originalID) || editing.committing} onChange={event => editing.setComputerId(event.target.value)}><option value="">This computer</option>{editingContext.computers.map(computer => <option key={computer.id} value={computer.id} disabled={!computer.connected}>{computer.name}{!computer.connected ? " (offline)" : ""}</option>)}</select></label> : undefined}
                focusRequest={editing.editorFocusRequest}
                created={Boolean(editing.editor.originalID && editingContext?.isMachineCreated?.(machine))}
                running={Boolean(editing.editor.originalID && machine.kind === "vm" && editingContext?.isMachineRunning?.(machine))}
                editor={editing.editor}
                baselineMachine={editing.editorBaseline ?? undefined}
                conflict={editing.editorConflict}
                review={editing.editorReview}
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
            <TabsContent value="overview"><OverviewTab workspace={workspace} source={source} actions={actions} active={activeTab === "overview" && controls.pageActive !== false} onEdit={canEdit ? () => editing.startEdit(machine) : undefined} onNavigate={controls.onNavigate} /></TabsContent>
            {showCheckpoints && <TabsContent value="checkpoints">
              <CheckpointPanel workspace={workspace} target={target} actions={actions} takenNames={sandboxNamesOnComputer(source.workspaces, workspace.computer?.id)} disabled={controls.configurationLocked || Boolean(workspace.lifecycleAction) || Boolean(workspace.computer?.busy) || workspace.freshness === "stale"} onExport={controls.onCheckpointExport} exportDisabled={controls.checkpointExportDisabled} forkedAction={controls.onCheckpointForkedAction} restoredAction={controls.onCheckpointRestoredAction} />
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
