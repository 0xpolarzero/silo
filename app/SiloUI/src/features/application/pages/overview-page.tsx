import { ForkStateDialog } from "../components/fork-state-dialog"
import { useSshAccessRefresh } from "./use-ssh-access-refresh"
import { SshAccessBadges } from "./ssh-access-panel"
import { StatusFolderPicker } from "@/features/status-bar/status-folder-picker"
import { workspaceAvailability } from "../model/workspace-availability"
import { ComputerBadge } from "@/features/sandboxes/components/computer-badge"
import { workspaceTarget } from "../model/remote-computers"
import { ConnectComputerForm } from "../components/remote-computers-settings"
import { SandboxDetailPage, type SandboxDetailControls } from "./sandbox-detail-page"
import { CircleAlert, Code, CopyPlus, Download, GitFork, HardDrive, History, Loader2, Monitor, Pencil, Play, RotateCw, Square, Terminal, Trash2, TriangleAlert } from "lucide-react"
import { useEffect, useEffectEvent, useRef, useState } from "react"

import type { MenuAction } from "@/components/actions-menu"
import type { BackupController } from "../model/backup-source"
import type { WorkspaceCheckpoint } from "../model/checkpoint-source"

import { ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { setupMachineConfigurationSchema, type SetupMachineConfiguration, type SiloProgressEvent } from "@/contracts/silo"
import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import { OperationQueueIndicator, WorkspaceWaitingStatus } from "@/features/application/components/operation-queue-panel"
import { emptyOperationQueue, waitingOperationForVm, cancelledActionLabel } from "@/features/application/model/operation-queue"
import type {
  ApplicationActions,
  ApplicationSource,
  ApplicationWorkspace,
  SandboxConfigurationOperation,
  SandboxDetailTab,
  WorkspaceState,
} from "@/features/application/model/application-source"
import { MachineList } from "@/features/sandboxes/components/machine-list"
import { SandboxAction, type SandboxIconState } from "@/features/sandboxes/components/sandbox-list"

import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"
import { workspaceIconState, workspaceRowTone } from "@/features/sandboxes/model/workspace-presentation"

const attentionPriority: Record<SandboxIconState, number> = {
  error: 0,
  warning: 1,
  normal: 2,
}

interface ConfigurationRowView {
  status: "running" | "failed"
  message: string
  completedSteps?: number
  recovery?: string
  retryable: boolean
}

const configurationSteps = new Set([
  "workspace-configuration",
  "workspace-networking",
  "workspace-verification",
])

function emptyWorkspace(machine: SetupMachineConfiguration): ApplicationWorkspace {
  return {
    machine,
    purpose: "New sandbox",
    state: "stopped",
    stateDetail: "Not configured",
    freshness: "fresh",
    host: machine.kind === "ssh" ? machine.host : `${machine.name}.silo.test`,
    repositories: [],
    files: [],
    ports: [],
    logs: [],
    githubRepositories: [],
    secretNames: [],
  }
}

function displayWorkspaces(source: ApplicationSource): ApplicationWorkspace[] {
  const operation = source.sandboxConfigurationOperation
  if (!operation) return source.workspaces
  const committedIDs = new Set(source.workspaces.map(({ machine }) => machine.id))
  const candidatesByID = new Map(operation.candidate.machines.map((machine) => [machine.id, machine]))
  return [
    ...source.workspaces.map((workspace) => ({
      ...workspace,
      machine: candidatesByID.get(workspace.machine.id) ?? workspace.machine,
    })),
    ...operation.candidate.machines
      .filter(({ id }) => !committedIDs.has(id))
      .map(emptyWorkspace),
  ]
}

function latestSafeEvent(operation: SandboxConfigurationOperation, workspace: string): SiloProgressEvent | undefined {
  const activeRevision = operation.progressEvents.findLast(({ revision }) => revision)?.revision
  return operation.progressEvents.findLast((event) => (
    event.safeForDisplay
    && event.workspace === workspace
    && (!activeRevision || !event.revision || event.revision === activeRevision)
  ))
}

function configurationRowView(
  workspace: ApplicationWorkspace,
  committedWorkspace: ApplicationWorkspace | undefined,
  operation: SandboxConfigurationOperation,
): ConfigurationRowView | undefined {
  const candidate = operation.candidate.machines.find(({ id }) => id === workspace.machine.id)
  const candidateName = candidate?.name ?? workspace.machine.name
  const removed = Boolean(committedWorkspace && !candidate)
  const addedOrChanged = !committedWorkspace || JSON.stringify(setupMachineConfigurationSchema.parse(committedWorkspace.machine)) !== JSON.stringify(candidate && setupMachineConfigurationSchema.parse(candidate))
  const errorTargetsWorkspace = operation.status === "failed"
    && (operation.error.workspace === candidateName || (!operation.error.workspace && (removed || addedOrChanged)))

  if (errorTargetsWorkspace) {
    return {
      status: "failed",
      message: operation.error.message,
      recovery: operation.error.recovery ?? undefined,
      retryable: operation.error.retryable,
    }
  }
  if (operation.status === "failed") return undefined
  if (removed) {
    return {
      status: "running",
      message: "Removing sandbox from Silo. Persistent volumes will be retained.",
      retryable: false,
    }
  }

  const latest = latestSafeEvent(operation, candidateName)
  if (!latest && !addedOrChanged) return undefined
  if (!latest) {
    return {
      status: "running",
      message: "Preparing sandbox configuration.",
      completedSteps: 0,
      retryable: false,
    }
  }

  const completedSteps = new Set(operation.progressEvents
    .filter((event) => event.workspace === candidateName && event.step && event.fraction === 1 && configurationSteps.has(event.step))
    .map(({ step }) => step)).size
  return {
    status: "running",
    message: latest.message,
    completedSteps,
    retryable: false,
  }
}

function ConfigurationIcon({ failed }: { failed: boolean }) {
  return (
    <ListRowIcon aria-hidden="true" className={failed
      ? "mt-1 self-start bg-destructive/10 text-destructive"
      : undefined}
    >
      {failed
        ? <CircleAlert className="size-3.5" aria-hidden="true" />
        : <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
    </ListRowIcon>
  )
}

function ConfigurationDetail({ view }: { view: ConfigurationRowView }) {
  const failed = view.status === "failed"
  const progressLabel = view.completedSteps === undefined ? undefined : `${view.completedSteps} of 3 steps complete`
  if (!failed) {
    return (
      <div role="status" aria-live="polite" aria-atomic="true" className="relative h-4 min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 truncate" title={view.message}>{view.message}</span>
          {progressLabel && <span className="shrink-0 text-[10px] text-muted-foreground">{progressLabel}</span>}
        </div>
        {view.completedSteps !== undefined && (
          <Progress aria-label={progressLabel} value={(view.completedSteps / 3) * 100} className="absolute inset-x-0 -bottom-1 h-0.5" />
        )}
      </div>
    )
  }
  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      aria-atomic="true"
      className="grid gap-1.5 py-0.5"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <p className={failed ? "text-destructive" : "text-muted-foreground"}>{view.message}</p>
        {progressLabel && <span className="shrink-0 text-[10px] text-muted-foreground">{progressLabel}</span>}
      </div>
      {view.completedSteps !== undefined && (
        <Progress aria-label={progressLabel} value={(view.completedSteps / 3) * 100} className="mt-0.5" />
      )}
      {view.recovery && <p className="text-[10px] text-muted-foreground">{view.recovery}</p>}
    </div>
  )
}

function WorkspaceActions({ machine, target, state, actions, disabled = false }: { target?: string; machine: SetupMachineConfiguration; state: WorkspaceState; actions: ApplicationActions; disabled?: boolean }) {
  const canStop = state === "running" || state === "starting"
  return (
    <>
      {canStop
        ? <SandboxAction label={`Stop ${machine.name}`} disabled={disabled} onClick={() => actions.stopWorkspace(target ?? machine.name)}><Square /></SandboxAction>
        : <SandboxAction label={`Start ${machine.name}`} disabled={disabled} onClick={() => actions.startWorkspace(target ?? machine.name)}><Play /></SandboxAction>}
    </>
  )
}

export function OverviewPage({ active = true, readOnly = false,
  source,
  actions,
  backup,
  onMachinesChange,
  newSandboxRequest,
  onNewSandboxRequestHandled,
  onExportSandbox,
  onImportSandbox,
  selectedSandboxId,
  sandboxTab,
  onOpenSandbox,
  onCloseSandbox,
  onSelectSandboxTab,
}: {
  active?: boolean
  readOnly?: boolean
  newSandboxRequest?: number
  onNewSandboxRequestHandled?: (id: number) => void
  /** Pick a folder and export a sandbox (or one of its checkpoints) as a background toast. */
  onExportSandbox?: (sandboxName: string, checkpoint?: { id: string; name: string }) => void
  /** Open the import review dialog after picking an export file. */
  onImportSandbox?: () => void
  source: ApplicationSource
  actions: ApplicationActions
  backup?: BackupController
  onMachinesChange: (machines: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[]) => Promise<void> | void
  /** The open sandbox detail page, its tab, and navigation callbacks. When omitted, the
   * page keeps its own selection state so it works standalone (fixtures and unit tests). */
  selectedSandboxId?: string | null
  sandboxTab?: SandboxDetailTab
  onOpenSandbox?: (workspace: string, tab?: SandboxDetailTab) => void
  onCloseSandbox?: () => void
  onSelectSandboxTab?: (tab: SandboxDetailTab) => void
}) {
  useSshAccessRefresh(readOnly ? undefined : actions.refreshSshAccess, active)
  const [folderWorkspaceId, setFolderWorkspaceId] = useState<string | null>(null)
  const [forkStateWorkspaceId, setForkStateWorkspaceId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [pendingStart, setPendingStart] = useState<string | null>(null)
  const [operationUnavailable, setOperationUnavailable] = useState(false)
  // Sandbox detail selection: controlled by the app's navigation when the callbacks are
  // supplied, otherwise kept locally so the page still opens details on its own.
  const controlledNav = onOpenSandbox !== undefined
  const [internalSandbox, setInternalSandbox] = useState<{ id: string; tab: SandboxDetailTab } | null>(null)
  const selectedId = controlledNav ? selectedSandboxId ?? null : internalSandbox?.id ?? null
  const activeSandboxTab: SandboxDetailTab = controlledNav ? sandboxTab ?? "overview" : internalSandbox?.tab ?? "overview"
  const openSandbox = (id: string, tab: SandboxDetailTab = "overview") => { if (controlledNav) onOpenSandbox!(id, tab); else setInternalSandbox({ id, tab }) }
  const closeSandbox = () => { if (controlledNav) onCloseSandbox?.(); else setInternalSandbox(null) }
  const selectSandboxTab = (tab: SandboxDetailTab) => { if (controlledNav) onSelectSandboxTab?.(tab); else setInternalSandbox((current) => current ? { ...current, tab } : current) }
  // Edit/Duplicate/Delete from a detail page are run by the list, which owns those flows.
  const [machineAction, setMachineAction] = useState<{ token: number; machineId: string; action: "edit" | "duplicate" | "delete" }>()
  const machineActionToken = useRef(0)
  function requestMachineAction(machineId: string, action: "edit" | "duplicate" | "delete") {
    closeSandbox()
    setMachineAction({ token: ++machineActionToken.current, machineId, action })
  }
  const backupOperation = backup?.state.operation
  const transferBusy = backupOperation?.kind === "running"
  const exportSandbox = !readOnly && backup && onExportSandbox ? onExportSandbox : undefined
  const importSandbox = !readOnly && backup && onImportSandbox ? onImportSandbox : undefined
  const visibleWorkspaces = displayWorkspaces(source)
  const workspaces = new Map(visibleWorkspaces.map((workspace) => [workspace.machine.id, workspace]))
  const committedWorkspaces = new Map(source.workspaces.map((workspace) => [workspace.machine.id, workspace]))
  const machines = visibleWorkspaces.map(({ machine }) => machine)
  const forkStateWorkspace = forkStateWorkspaceId ? workspaces.get(forkStateWorkspaceId) : undefined
  const configurationOperation = source.sandboxConfigurationOperation
  const configurationLocked = readOnly || configurationOperation !== null
  const localMachines = machines.filter(machine => !workspaces.get(machine.id)?.computer)
  const localOnly = (list: readonly SetupMachineConfiguration[]) => list.filter(machine => !workspaces.get(machine.id)?.computer)

  // Return to the list if the open sandbox disappeared (deleted, or removed by a refresh).
  const detailWorkspace = selectedId ? workspaces.get(selectedId) : undefined
  const detailMissing = Boolean(selectedId) && !detailWorkspace
  const returnToList = useEffectEvent(() => closeSandbox())
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { if (detailMissing) returnToList() }, [detailMissing])

  // Build the save from the baseline the editor started from (falling back to the live
  // local list) so the change carries the right `expected` state and does not drag other
  // sandboxes' concurrent edits into this one.
  function updateLocal(machine: SetupMachineConfiguration, original?: SetupMachineConfiguration, baseline?: SetupMachineConfiguration[]) {
    const base = baseline ? localOnly(baseline) : localMachines
    const next = original ? base.map(item => item.id === original.id ? machine : item) : [...base, machine]
    return onMachinesChange(next, baseline ? base : undefined)
  }

  // A single set of lifecycle handlers, guarded for capacity and unavailable-operation
  // notices, shared by the row controls and the detail page so both behave identically.
  function guardedLifecycle(workspace?: ApplicationWorkspace): Pick<ApplicationActions, "startWorkspace" | "stopWorkspace" | "restartWorkspace"> {
    const isLocal = !workspace?.computer
    return {
      startWorkspace: (name) => {
        if (isLocal && source.vmOperationsUnavailable) setOperationUnavailable(true)
        else if (source.resourceNotice?.kind === "start-memory" && source.resourceNotice.sandbox === name) setPendingStart(name)
        else actions.startWorkspace(name)
      },
      stopWorkspace: (name) => isLocal && source.vmOperationsUnavailable ? setOperationUnavailable(true) : actions.stopWorkspace(name),
      restartWorkspace: (name) => isLocal && source.vmOperationsUnavailable ? setOperationUnavailable(true) : actions.restartWorkspace(name),
    }
  }

  const folderWorkspace = folderWorkspaceId ? workspaces.get(folderWorkspaceId) : undefined
  if (folderWorkspace && workspaceAvailability(folderWorkspace, source).canOpen) {
    return <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <StatusFolderPicker key={folderWorkspace.machine.id} workspace={folderWorkspace} editor={source.preferences.editor} listDirectory={actions.listWorkspaceDirectory} onBack={() => setFolderWorkspaceId(null)} onOpen={(path) => actions.openEditor(workspaceTarget(folderWorkspace), path)} />
    </div>
  }

  function detailControls(workspace: ApplicationWorkspace): SandboxDetailControls {
    const machine = workspace.machine
    const target = workspaceTarget(workspace)
    const state = workspace.state
    const stale = workspace.freshness === "stale"
    const isLocal = !workspace.computer
    const isRunning = state === "running"
    const workspaceOperationBusy = Boolean(workspace.lifecycleAction) || workspace.checkpointOperation?.status === "running" || Boolean(workspace.computer?.busy)
    const availability = workspaceAvailability(workspace, source)
    const guarded = guardedLifecycle(workspace)
    const lifecycleAction = workspace.lifecycleFailureAction
    const menuActions: MenuAction[] = [
      ...(machine.kind === "vm" && machine.desktop && actions.openDesktop ? [{ label: "Open Linux desktop", icon: Monitor, accessibleLabel: `Open ${machine.name} desktop`, disabled: configurationLocked || workspaceOperationBusy || Boolean(workspace.computer && stale), onSelect: () => { void actions.openDesktop!(target) } }] : []),
      { label: "Restart", icon: RotateCw, accessibleLabel: `Restart ${machine.name}`, disabled: configurationLocked || workspaceOperationBusy || Boolean(workspace.computer && stale) || (state !== "running" && state !== "failed"), onSelect: () => guarded.restartWorkspace(target) },
      ...(machine.kind === "vm" && actions.forkCheckpoint ? [{ label: "Fork…", icon: GitFork, accessibleLabel: `Fork ${machine.name}`, disabled: configurationLocked || workspaceOperationBusy || Boolean(workspace.computer?.busy) || stale, onSelect: () => setForkStateWorkspaceId(machine.id) }] : []),
      ...(machine.kind === "vm" && isLocal && exportSandbox ? [{ label: "Export…", icon: Download, accessibleLabel: `Export ${machine.name}`, disabled: configurationLocked || workspaceOperationBusy || transferBusy || stale, onSelect: () => exportSandbox(machine.name) }] : []),
      { label: "Edit", separatorBefore: true, icon: Pencil, accessibleLabel: `Edit ${machine.name}`, disabled: configurationLocked, onSelect: () => requestMachineAction(machine.id, "edit") },
      { label: "Duplicate", icon: CopyPlus, accessibleLabel: `Duplicate ${machine.name}`, disabled: configurationLocked, onSelect: () => requestMachineAction(machine.id, "duplicate") },
      { label: "Delete", icon: Trash2, destructive: true, accessibleLabel: `Delete ${machine.name}`, disabled: configurationLocked || (machine.kind === "vm" && isRunning), onSelect: () => requestMachineAction(machine.id, "delete") },
    ]
    return {
      onBack: closeSandbox,
      activeTab: activeSandboxTab,
      onSelectTab: selectSandboxTab,
      readOnly,
      configurationLocked,
      workspaceOperationBusy,
      canOpen: availability.canOpen && !readOnly,
      canStart: availability.canStart && !readOnly,
      canStop: availability.canStop && !readOnly,
      menuActions,
      onTerminal: () => actions.openTerminal(target),
      onEditor: () => setFolderWorkspaceId(machine.id),
      onStart: () => guarded.startWorkspace(target),
      onStop: () => guarded.stopWorkspace(target),
      onRetryLifecycle: workspace.lifecycleFailure && lifecycleAction && lifecycleAction !== "dismiss-error" && !readOnly
        ? () => { if (lifecycleAction === "start") guarded.startWorkspace(target); else if (lifecycleAction === "stop") guarded.stopWorkspace(target); else if (lifecycleAction === "restart") guarded.restartWorkspace(target) }
        : undefined,
      onCheckpointExport: exportSandbox ? (checkpoint: WorkspaceCheckpoint) => exportSandbox(machine.name, { id: checkpoint.id, name: checkpoint.name }) : undefined,
      checkpointExportDisabled: transferBusy || backup?.state.availability === "unavailable",
    }
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <div className="min-h-0 flex-1">
        {detailWorkspace ? (
          <SandboxDetailPage workspace={detailWorkspace} source={source} actions={actions} controls={detailControls(detailWorkspace)} />
        ) : (
          <>
            {connecting && actions.connectComputer && <div className="mb-3"><ConnectComputerForm connect={actions.connectComputer} authorize={actions.authorizeComputer} setupKey={actions.setupComputerKey} onClose={() => setConnecting(false)} /></div>}
            <OperationQueueIndicator queue={source.operationQueue} reduceMotion={source.preferences.reduceMotion} onCancel={readOnly ? undefined : actions.cancelOperation} />
            {configurationOperation?.status === "failed" && <div className="mb-3 rounded-md border border-destructive/30 p-3">
              <p role="alert" className="text-sm text-destructive">{configurationOperation.error.message}</p>
              <Button variant="outline" size="sm" className="mt-2" disabled={readOnly} onClick={() => actions.dismissMachineConfigurationError()}>Dismiss configuration error</Button>
            </div>}
            <MachineList
              newSandboxRequest={readOnly ? undefined : newSandboxRequest}
              onNewSandboxRequestHandled={onNewSandboxRequestHandled}
              onOpenMachine={(machine) => openSandbox(machine.id)}
              machineActionRequest={machineAction}
              onMachineActionHandled={(token) => setMachineAction((current) => current?.token === token ? undefined : current)}
              machines={machines}
              computers={source.remoteComputers}
              getComputerId={machine => workspaces.get(machine.id)?.computer?.id}
              onConnectComputer={actions.connectComputer ? () => setConnecting(true) : undefined}
              onImportSandbox={importSandbox}
              onCommitMachine={actions.saveRemoteMachine ? async (machine, original, computerId, baseline) => {
                if (computerId) await actions.saveRemoteMachine!(computerId, machine, original)
                else await updateLocal(machine, original, baseline)
              } : undefined}
              onDeleteMachine={actions.deleteRemoteMachine ? async (machine, baseline) => {
                const computer = workspaces.get(machine.id)?.computer
                if (computer) {
                  if (!computer.connected) throw new Error("This computer is unavailable. Reconnect before deleting its VM.")
                  await actions.deleteRemoteMachine!(computer.id, machine)
                } else {
                  const base = baseline ? localOnly(baseline) : localMachines
                  await onMachinesChange(base.filter(item => item.id !== machine.id), baseline ? base : undefined)
                }
              } : undefined}
              isMachineCreated={(machine) => committedWorkspaces.has(machine.id)}
              isMachineRunning={(machine) => workspaces.get(machine.id)?.state === "running"}
              onMachinesChange={(next, baseline) => {
                if (source.vmOperationsUnavailable) { setOperationUnavailable(true); return }
                return onMachinesChange(localOnly(next), baseline ? localOnly(baseline) : undefined)
              }}
              interactionDisabled={configurationLocked}
              validateOperation={(machine, isNew, computerId) => {
                const computer = workspaces.get(machine.id)?.computer ?? source.remoteComputers?.find(computer => computer.id === computerId)
                if (computer) return computer.busy ? "This computer is refreshing its VM status. Try again shortly." : computer.connected ? undefined : "This computer is unavailable. Reconnect before changing its VMs."
                if (source.vmOperationsUnavailable) return source.vmOperationsUnavailable
                const notice = source.resourceNotice
                if (!isNew || machine.kind !== "vm" || notice?.kind !== "create-storage" || machine.name !== notice.sandbox) return undefined
                return `Not enough storage to create ${machine.name}. About ${notice.requiredGB} GB is needed on ${notice.volume}; ${notice.availableGB} GB is available. No sandbox was created.`
              }}
              summary={configurationOperation ? <>{source.workspaces.length} configured · {configurationOperation.status === "failed" ? "Sandbox changes failed" : "Applying sandbox changes"}</> : undefined}
              sortPriority={(machine) => {
                const workspace = workspaces.get(machine.id)
                const configuration = workspace && !workspace.computer && configurationOperation
                  ? configurationRowView(workspace, committedWorkspaces.get(machine.id), configurationOperation)
                  : undefined
                return attentionPriority[configuration?.status === "failed" ? "error" : workspaceIconState(workspace)]
              }}
              getRowPresentation={(machine) => {
                const workspace = workspaces.get(machine.id)
                const state = workspace?.state ?? "stopped"
                // The operation gate keys per-VM entries by the local workspace name. A
                // remote computer's VMs run on that computer's own gate, so never match a
                // local queue entry against a remote workspace. Local entries are keyed by
                // the stable VM id, so matching uses the id rather than the display name.
                const queueVmId = workspace?.computer ? null : machine.id
                const pendingSecrets = machine.kind === "vm" && !workspace?.computer
                  ? source.secrets.filter((secret) => secret.state === "restart-required" && secret.workspaces.includes(machine.name)).map((secret) => secret.name)
                  : []
                const badge = pendingSecrets.length > 0
                  ? <SecretChangesLabel workspace={machine.name} state={state} secrets={pendingSecrets} />
                  : undefined
                const visualState = workspaceIconState(workspace)
                const configuration = workspace && !workspace.computer && configurationOperation
                  ? configurationRowView(workspace, committedWorkspaces.get(machine.id), configurationOperation)
                  : undefined
                if (configuration) {
                  const failed = configuration.status === "failed"
                  return {
                    badge,
                    busy: !failed,
                    suppressInteractions: true,
                    icon: <ConfigurationIcon failed={failed} />,
                    iconState: failed ? "error" as const : "normal" as const,
                    tone: failed ? "error" as const : "starting" as const,
                    detailClassName: failed ? "overflow-visible whitespace-normal text-xs" : "overflow-visible",
                    detail: <ConfigurationDetail view={configuration} />,
                    actions: failed && configuration.retryable
                      ? <SandboxAction label={`Retry ${machine.name} configuration`} disabled={readOnly} onClick={() => actions.retryMachineConfiguration(machine.name)}><RotateCw /></SandboxAction>
                      : undefined,
                    actionsClassName: failed ? "mt-1 self-start" : undefined,
                  }
                }
                const access = workspace && source.sshAccess?.workspaces.find(row => row.workspace === workspaceTarget(workspace))
                const sshStale = Boolean((source.sshAccessError && !workspace?.computer) || workspace?.computer?.connected === false || workspace?.freshness === "stale")
                const lifecycle = workspace?.lifecycleAction
                const checkpointOperation = workspace?.checkpointOperation?.status === "running" ? workspace.checkpointOperation : undefined
                const lifecycleLabel = lifecycle === "dismiss-error" ? "Dismissing…" : lifecycle === "restart" ? "Restarting…" : lifecycle === "stop" ? "Stopping…" : "Starting…"
                const workspaceOperationBusy = Boolean(lifecycle) || Boolean(checkpointOperation)
                const stale = workspace?.freshness === "stale"
                // A pending lifecycle action can still be waiting its turn in the gate. Until
                // its queue entry runs, the row reads "Waiting for <blocker>…" rather than the
                // pending-action label, so the user sees what is holding the action up.
                const waitingForVm = queueVmId !== null ? waitingOperationForVm(source.operationQueue ?? emptyOperationQueue, queueVmId) : undefined
                const guarded = guardedLifecycle(workspace)
                return {
                  kindBadge: workspace?.computer ? <ComputerBadge computer={workspace.computer} /> : undefined,
                  badge: <>{badge}<SshAccessBadges access={access} stale={sshStale} /></>,
                  menuActions: [
                    ...(machine.kind === "vm" && machine.desktop && actions.openDesktop ? [{ label: "Open Linux desktop", icon: Monitor, accessibleLabel: `Open ${machine.name} desktop`, disabled: configurationLocked || workspaceOperationBusy || Boolean(workspace?.computer && stale), onSelect: () => { void actions.openDesktop!(workspace ? workspaceTarget(workspace) : machine.name) } }] : []),
                    { label: "Restart", icon: RotateCw, accessibleLabel: `Restart ${machine.name}`, disabled: configurationLocked || workspaceOperationBusy || Boolean(workspace?.computer && stale) || (state !== "running" && state !== "failed"), onSelect: () => guarded.restartWorkspace(workspace ? workspaceTarget(workspace) : machine.name) },
                    ...(machine.kind === "vm" && workspace ? [{ label: "Checkpoints", icon: History, accessibleLabel: `Checkpoints for ${machine.name}`, disabled: configurationLocked || workspaceOperationBusy || Boolean(workspace.computer?.busy) || stale, onSelect: () => openSandbox(machine.id, "checkpoints") }] : []),
                    ...(machine.kind === "vm" && workspace && actions.forkCheckpoint ? [{ label: "Fork…", icon: GitFork, accessibleLabel: `Fork ${machine.name}`, disabled: configurationLocked || workspaceOperationBusy || Boolean(workspace.computer?.busy) || stale, onSelect: () => setForkStateWorkspaceId(machine.id) }] : []),
                    ...(machine.kind === "vm" && workspace && !workspace.computer && actions.readWorkspaceStorage ? [{ label: "Storage", icon: HardDrive, accessibleLabel: `Storage for ${machine.name}`, disabled: configurationOperation !== null || workspaceOperationBusy, onSelect: () => openSandbox(machine.id, "storage") }] : []),
                    ...(machine.kind === "vm" && workspace && !workspace.computer && exportSandbox ? [{ label: "Export…", icon: Download, accessibleLabel: `Export ${machine.name}`, disabled: configurationLocked || workspaceOperationBusy || transferBusy || stale, onSelect: () => exportSandbox(machine.name) }] : []),
                  ],
                  expandedContent: workspace?.lifecycleFailure ? <>
                    {(() => {
                      const retry = workspace.lifecycleFailureAction && workspace.lifecycleFailureAction !== "dismiss-error" && !readOnly
                        ? <div className="mt-2 flex justify-end">
                            <Button size="xs" variant="outline" disabled={workspaceOperationBusy} onClick={() => {
                              const target = workspaceTarget(workspace)
                              if (workspace.lifecycleFailureAction === "start") guarded.startWorkspace(target)
                              else if (workspace.lifecycleFailureAction === "stop") guarded.stopWorkspace(target)
                              else if (workspace.lifecycleFailureAction === "restart") guarded.restartWorkspace(target)
                            }}>Retry</Button>
                          </div>
                        : null
                      // A cancellation is the user's own choice, not a failure: show it as a
                      // neutral, muted status with the same Retry, never the destructive alert.
                      return workspace.lifecycleFailureCancelled
                        ? <div role="status" className="mx-3 mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                            {cancelledActionLabel(workspace.lifecycleFailureAction ?? "start")}
                            {retry}
                          </div>
                        : <div role="alert" className="mx-3 mb-2 max-h-48 overflow-auto rounded-md border border-destructive/20 bg-destructive/[.06] px-3 py-2 text-xs whitespace-pre-wrap break-words text-destructive">
                            {workspace.lifecycleFailure}
                            {retry}
                          </div>
                    })()}
                  </> : undefined,
                  busy: workspaceOperationBusy || Boolean(workspace?.computer?.busy),
                  suppressInteractions: workspaceOperationBusy || Boolean(workspace?.computer?.busy) || Boolean(workspace?.computer && !workspace.computer.connected),
                  icon: workspaceOperationBusy ? <ListRowIcon aria-hidden="true"><Loader2 className="size-3.5 animate-spin" /></ListRowIcon> : undefined,
                  iconState: workspace?.lifecycleFailure && !workspace.lifecycleFailureCancelled ? "error" as const : visualState,
                  tone: workspaceOperationBusy ? "starting" as const : workspace?.lifecycleFailure && !workspace.lifecycleFailureCancelled ? "error" as const : workspaceRowTone(workspace),
                  detail: checkpointOperation ? <div role="status" aria-live="polite" aria-atomic="true" className="grid gap-1.5 py-0.5">
                    <p className="truncate text-xs" title={checkpointOperation.stage}>{checkpointOperation.stage}</p>
                    <Progress value={null} aria-label="Checkpoint operation progress" />
                  </div> : (
                    <span className="inline-flex max-w-full items-center gap-1 align-middle">
                      <span className="truncate" title={workspace?.attention?.message}>
                        {lifecycle
                          ? (waitingForVm && queueVmId !== null
                              ? <WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={readOnly ? undefined : actions.cancelOperation} />
                              : <span role="status" className="text-amber-700 dark:text-amber-400">{lifecycleLabel}</span>)
                          : workspace?.computer?.busy ? <span role="status">Refreshing status…</span> : workspace?.computer && !workspace.computer.connected ? <span>Unavailable</span> : <WorkspaceStateLabel state={state} />}
                        {workspace?.attention && <> · {workspace.attention.message}</>}
                        {!lifecycle && !workspaceOperationBusy && queueVmId !== null && waitingForVm && <> · <WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={readOnly ? undefined : actions.cancelOperation} /></>}
                      </span>
                      {workspace?.canDismissError && state === "failed" && <Button size="xs" variant="ghost" className="h-4 rounded px-1 text-[10px] font-normal" aria-label={`Dismiss ${machine.name} error`} disabled={configurationLocked || workspaceOperationBusy || stale} onClick={() => actions.dismissWorkspaceError(workspaceTarget(workspace))}>Dismiss</Button>}
                    </span>
                  ),
                  actions: <>
                    <SandboxAction label={`Open ${machine.name} in ${source.preferences.terminal}`} disabled={readOnly || !workspace || !workspaceAvailability(workspace, source).canOpen} onClick={() => workspace && actions.openTerminal(workspaceTarget(workspace))}><Terminal /></SandboxAction>
                    <SandboxAction label={`Open ${machine.name} in ${source.preferences.editor}`} disabled={readOnly || !workspace || !workspaceAvailability(workspace, source).canOpen} onClick={() => setFolderWorkspaceId(machine.id)}><Code /></SandboxAction>
                    <WorkspaceActions target={workspace && workspaceTarget(workspace)} machine={machine} state={state} actions={{
                    ...actions,
                    ...guarded,
                  }} disabled={configurationLocked || workspaceOperationBusy || Boolean(workspace?.computer && stale)} />
                  </>,
                }
              }}
            />
          </>
        )}
      </div>
      {forkStateWorkspace && actions.forkCheckpoint && <ForkStateDialog
        key={forkStateWorkspace.machine.id}
        sandboxName={forkStateWorkspace.machine.name}
        disabled={configurationLocked || Boolean(forkStateWorkspace.lifecycleAction) || Boolean(forkStateWorkspace.computer?.busy) || forkStateWorkspace.freshness === "stale" || forkStateWorkspace.checkpointOperation?.status === "running"}
        progressStage={forkStateWorkspace.checkpointOperation?.status === "running" ? forkStateWorkspace.checkpointOperation.stage : undefined}
        fork={name => actions.forkCheckpoint!(workspaceTarget(forkStateWorkspace), null, name)}
        onClose={() => setForkStateWorkspaceId(null)}
      />}
      {pendingStart && source.resourceNotice?.kind === "start-memory" && <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[.07] p-3" role="status">
        <div className="flex gap-2"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden="true" /><div><p className="text-xs font-medium">Starting {pendingStart} may slow this computer</p><p className="mt-1 text-[11px] text-muted-foreground">Silo found high memory pressure now. This VM can use up to {source.resourceNotice.memoryGiB} GB. Close memory-heavy apps, or start anyway.</p></div></div>
        <div className="mt-2 flex justify-end gap-1"><Button type="button" variant="ghost" size="xs" onClick={() => setPendingStart(null)}>Cancel</Button><Button type="button" variant="outline" size="xs" onClick={() => { actions.startWorkspace(pendingStart); setPendingStart(null) }}>Start anyway</Button></div>
      </div>}
      {operationUnavailable && source.vmOperationsUnavailable && <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/[.06] p-3" role="alert"><div className="flex gap-2"><CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-xs font-medium">VM operation unavailable</p><p className="mt-1 text-[11px] text-muted-foreground">{source.vmOperationsUnavailable}</p></div></div><div className="mt-2 flex justify-end"><Button variant="ghost" size="xs" onClick={() => setOperationUnavailable(false)}>Dismiss</Button></div></div>}
    </div>
  )
}
