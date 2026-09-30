import { ForkBody } from "../components/fork-popover"
import { AccountMigrationBody } from "../components/account-migration"
import { runAccountMigration } from "../model/account-migration"
import { runCheckpointOperation, syncCheckpointProgress } from "../model/checkpoint-operation-toast"
import { useSshAccessRefresh } from "./use-ssh-access-refresh"
import { SshAccessBadges } from "./ssh-access-panel"
import { StatusFolderPicker } from "@/features/status-bar/status-folder-picker"
import { workspaceAvailability, type WorkspaceAvailability } from "../model/workspace-availability"
import { DisabledReason } from "../components/disabled-reason"
import type { SandboxCommandRequest } from "../components/application-commands"
import { LifecycleControl } from "../components/lifecycle-control"
import { lifecycleGuard, type LifecycleAction, type LifecycleGuard } from "../model/lifecycle-guard"
import { ComputerBadge } from "@/features/sandboxes/components/computer-badge"
import { workspaceTarget } from "../model/remote-computers"
import { ConnectComputerForm } from "../components/remote-computers-settings"
import { SandboxDetailPage, type SandboxDetailControls, type SandboxDetailEditing } from "./sandbox-detail-page"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { CircleAlert, Code, Download, GitFork, HardDrive, History, Loader2, Monitor, Play, RotateCw, Square, Terminal, UserRoundCog } from "lucide-react"
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react"
import { dismissOperationToast, dismissSandboxToasts, showActionFailure, showOperationFailure, showOperationNotice, showOperationProgress } from "@/lib/operation-toast"

import type { MenuAction, MenuPopovers } from "@/components/actions-menu"
import { ConfirmBody } from "@/components/confirm-popover"
import type { BackupController, VerifiedExport } from "../model/backup-source"
import { sandboxNamesOnComputer, type WorkspaceCheckpoint } from "../model/checkpoint-source"

import { configurationFailureDiagnostic } from "../model/configuration-failure"
import { ErrorDetails } from "@/components/error-details"
import { ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { setupMachineConfigurationSchema, type SetupMachineConfiguration, type SiloProgressEvent } from "@/contracts/silo"
import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import { WorkspaceStatus } from "@/features/application/components/workspace-status"
import { emptyOperationQueue, waitingOperationForVm, waitingStatusText, cancelledActionLabel } from "@/features/application/model/operation-queue"
import type {
  ApplicationActions,
  ApplicationSource,
  ApplicationWorkspace,
  SandboxConfigurationOperation,
  SandboxDetailTab,
} from "@/features/application/model/application-source"
import { MachineList } from "@/features/sandboxes/components/machine-list"
import type { DeleteSandboxDetails } from "@/features/sandboxes/components/delete-sandbox-confirmation"
import { SandboxAction, type SandboxIconState } from "@/features/sandboxes/components/sandbox-list"

import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"
import { sandboxBusyReason, workspaceIconState, workspaceRowTone } from "@/features/sandboxes/model/workspace-presentation"
import { hostCapacityFrom } from "@/features/sandboxes/model/machine-limits"

/** A command palette request carried out on a sandbox's page. */
export interface SandboxPageRequest {
  token: number
  workspaceId: string
  request: SandboxCommandRequest
}

/** A lifecycle action shows a progress notification only if it is still running after this long. */
const LIFECYCLE_TOAST_DELAY_MS = 800

const attentionPriority: Record<SandboxIconState, number> = {
  error: 0,
  warning: 1,
  normal: 2,
}

interface ConfigurationRowView {
  status: "running" | "failed"
  message: string
  diagnostic?: string
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
      diagnostic: configurationFailureDiagnostic(operation, candidateName),
      recovery: operation.error.recovery ?? undefined,
      retryable: operation.error.retryable,
    }
  }
  if (operation.status === "failed") return undefined
  if (removed) {
    return {
      status: "running",
      message: "Deleting the sandbox’s files and checkpoints.",
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
        <ErrorDetails className="flex-1 text-destructive" message={view.message} diagnostic={view.diagnostic} fallbackSummary="Sandbox changes failed." />
        {progressLabel && <span className="shrink-0 text-[10px] text-muted-foreground">{progressLabel}</span>}
      </div>
      {view.completedSteps !== undefined && (
        <Progress aria-label={progressLabel} value={(view.completedSteps / 3) * 100} className="mt-0.5" />
      )}
      {view.recovery && <p className="text-[10px] text-muted-foreground">{view.recovery}</p>}
    </div>
  )
}

/** The row's Start or Stop control, through the shared lifecycle guard. */
function WorkspaceActions({ workspace, availability, readOnly, guard }: { workspace: ApplicationWorkspace; availability: WorkspaceAvailability; readOnly: boolean; guard: LifecycleGuard }) {
  const { machine } = workspace
  const action = workspace.state === "running" || workspace.state === "starting" ? "stop" : "start"
  const enabled = !readOnly && (action === "stop" ? availability.canStop : availability.canStart)
  const asks = enabled && guard.check(workspace, action).kind === "confirm"
  return <>
    {Boolean(workspace.pendingSecretRevocations?.length) && <LifecycleControl guard={guard} workspace={workspace} action="restart" disabled={readOnly || !availability.canRestart} reason={readOnly ? undefined : availability.reasons.restart}>
      {({ onClick, disabled }) => <SandboxAction label={`Restart ${machine.name}`} disabled={disabled} onClick={onClick}><RotateCw /></SandboxAction>}
    </LifecycleControl>}
    <LifecycleControl guard={guard} workspace={workspace} action={action} disabled={!enabled} reason={readOnly ? undefined : availability.reasons[action]}>
      {({ onClick, disabled }) => action === "stop"
        ? <SandboxAction label={`Stop ${machine.name}`} tooltip={asks ? `Stop ${machine.name}…` : undefined} disabled={disabled} onClick={onClick}><Square /></SandboxAction>
        : <SandboxAction label={`Start ${machine.name}`} tooltip={asks ? `Start ${machine.name}…` : undefined} disabled={disabled} onClick={onClick}><Play /></SandboxAction>}
    </LifecycleControl>
  </>
}

export function OverviewPage({ active = true, readOnly = false,
  source,
  actions,
  backup,
  onMachinesChange,
  newSandboxRequest,
  onNewSandboxRequestHandled,
  sandboxRequest,
  onSandboxRequestHandled,
  onExportSandbox,
  onImportSandbox,
  importPopover,
  selectedSandboxId,
  sandboxTab,
  onOpenSandbox,
  onCloseSandbox,
  onSelectSandboxTab,
  onNavigate,
}: {
  active?: boolean
  readOnly?: boolean
  newSandboxRequest?: number
  onNewSandboxRequestHandled?: (id: number) => void
  /** A palette command for a sandbox's page: its folder picker, Fork or Delete popover. */
  sandboxRequest?: SandboxPageRequest
  onSandboxRequestHandled?: (token: number) => void
  /** Pick a folder and export a sandbox (or one of its checkpoints) as a background toast. */
  onExportSandbox?: (sandboxName: string, checkpoint?: { id: string; name: string }) => void | Promise<VerifiedExport | null>
  /** Open the import review dialog after picking an export file. */
  onImportSandbox?: () => void
  /** Wraps the sandbox list's Add button so the import review popover anchors to it. */
  importPopover?: (addButton: ReactNode) => ReactNode
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
  /** Navigate to another section (Files/Network filtered to a sandbox, or the Secrets tab). */
  onNavigate?: (route: ApplicationInitialRoute) => void
}) {
  useSshAccessRefresh(readOnly ? undefined : actions.refreshSshAccess, active)
  // The editor folder picker replaces the page for the route it was opened from. It closes
  // for good when that route changes (palette, status panel, Back/Forward, another section)
  // or when its sandbox can no longer be opened, so it never takes the screen over later.
  const [folderPicker, setFolderPicker] = useState<{ workspaceId: string; route: string } | null>(null)
  const [connecting, setConnecting] = useState(false)
  // Sandbox detail selection: controlled by the app's navigation when the callbacks are
  // supplied, otherwise kept locally so the page still opens details on its own.
  const controlledNav = onOpenSandbox !== undefined
  const [internalSandbox, setInternalSandbox] = useState<{ id: string; tab: SandboxDetailTab } | null>(null)
  const selectedId = controlledNav ? selectedSandboxId ?? null : internalSandbox?.id ?? null
  const activeSandboxTab: SandboxDetailTab = controlledNav ? sandboxTab ?? "overview" : internalSandbox?.tab ?? "overview"
  const openSandbox = (id: string, tab: SandboxDetailTab = "overview") => { if (controlledNav) onOpenSandbox!(id, tab); else setInternalSandbox({ id, tab }) }
  const closeSandbox = () => { if (controlledNav) onCloseSandbox?.(); else setInternalSandbox(null) }
  const selectSandboxTab = (tab: SandboxDetailTab) => { if (controlledNav) onSelectSandboxTab?.(tab); else setInternalSandbox((current) => current ? { ...current, tab } : current) }
  // Duplicate from a detail page opens the list editor for the new sandbox, so it hands the
  // request to the list (which owns that flow) and returns to the list. Edit and Delete are
  // now handled in place on the detail page.
  const [machineAction, setMachineAction] = useState<{ token: number; machineId: string; action: "duplicate" }>()
  const machineActionToken = useRef(0)
  function requestDuplicate(machineId: string) {
    closeSandbox()
    setMachineAction({ token: ++machineActionToken.current, machineId, action: "duplicate" })
  }
  const backupOperation = backup?.state.operation
  const transferBusy = backupOperation?.kind === "running"
  const exportSandbox = !readOnly && backup && onExportSandbox ? onExportSandbox : undefined
  const importSandbox = !readOnly && backup && onImportSandbox ? onImportSandbox : undefined
  const visibleWorkspaces = displayWorkspaces(source)
  // Resolved lazily when a "Fork created" toast's Open button is clicked, so it finds the
  // newly forked sandbox once the backend snapshot includes it rather than at toast time.
  const workspacesRef = useRef(visibleWorkspaces)
  useEffect(() => { workspacesRef.current = visibleWorkspaces })
  const workspaces = new Map(visibleWorkspaces.map((workspace) => [workspace.machine.id, workspace]))
  const committedWorkspaces = new Map(source.workspaces.map((workspace) => [workspace.machine.id, workspace]))
  const machines = visibleWorkspaces.map(({ machine }) => machine)
  /** Whether "Fork…" is currently unavailable for a sandbox. */
  function forkDisabled(workspace: ApplicationWorkspace) {
    return configurationLocked || workspaceAvailability(workspace, source).busy || workspace.freshness === "stale"
  }
  /** The Fork popover body for a sandbox's ⋯ menu (row or detail page); state lives with that menu. */
  function forkPopovers(workspace: ApplicationWorkspace | undefined): MenuPopovers | undefined {
    if (!workspace || !actions.forkCheckpoint) return undefined
    return { fork: close => <ForkBody sandboxName={workspace.machine.name} disabled={forkDisabled(workspace)} takenNames={sandboxNamesOnComputer(visibleWorkspaces, workspace.computer?.id)} onFork={name => forkCurrentState(workspace, name)} onClose={close} /> }
  }
  const configurationOperation = source.sandboxConfigurationOperation
  const configurationLocked = readOnly || configurationOperation !== null
  const localMachines = machines.filter(machine => !workspaces.get(machine.id)?.computer)
  const localOnly = (list: readonly SetupMachineConfiguration[]) => list.filter(machine => !workspaces.get(machine.id)?.computer)

  // Return to the list if the open sandbox disappeared (deleted, or removed by a refresh).
  // Controlled navigation replaces its history entries in place (the app forgets missing
  // sandboxes), so only the standalone page closes its own selection here: pushing a new
  // entry would leave Back pointing at the missing sandbox.
  const detailWorkspace = selectedId ? workspaces.get(selectedId) : undefined
  const detailMissing = Boolean(selectedId) && !detailWorkspace
  const returnToList = useEffectEvent(() => { if (!controlledNav) closeSandbox() })
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

  // The sandbox editing callbacks, shared by the list and the detail page's in-place editor
  // and delete dialog so both commit, delete, and validate through exactly the same paths.
  const getMachineComputerId = (machine: SetupMachineConfiguration) => workspaces.get(machine.id)?.computer?.id
  const commitMachine = actions.saveRemoteMachine ? async (machine: SetupMachineConfiguration, original: SetupMachineConfiguration | undefined, computerId: string, baseline?: SetupMachineConfiguration[]) => {
    if (computerId) await actions.saveRemoteMachine!(computerId, machine, original)
    else await updateLocal(machine, original, baseline)
  } : undefined
  const deleteMachine = actions.deleteRemoteMachine ? async (machine: SetupMachineConfiguration, baseline?: SetupMachineConfiguration[]) => {
    const computer = workspaces.get(machine.id)?.computer
    if (computer) {
      if (!computer.connected) throw new Error(`${computer.name} is offline. Reconnect to it before deleting ${machine.name}.`)
      await actions.deleteRemoteMachine!(computer.id, machine)
    } else {
      const base = baseline ? localOnly(baseline) : localMachines
      await onMachinesChange(base.filter(item => item.id !== machine.id), baseline ? base : undefined)
    }
  } : undefined
  const changeMachines = (next: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[]) => {
    if (source.vmOperationsUnavailable) { notifyOperationUnavailable(); return }
    return onMachinesChange(localOnly(next), baseline ? localOnly(baseline) : undefined)
  }
  const validateMachineOperation = (machine: SetupMachineConfiguration, isNew: boolean, computerId?: string) => {
    const computer = workspaces.get(machine.id)?.computer ?? source.remoteComputers?.find(computer => computer.id === computerId)
    if (computer) return computer.busy ? `${computer.name} is updating. Wait before changing ${machine.name}.` : computer.connected ? undefined : `${computer.name} is offline. Reconnect to it before changing ${machine.name}.`
    if (source.vmOperationsUnavailable) return source.vmOperationsUnavailable
    const notice = source.resourceNotice
    if (!isNew || machine.kind !== "vm" || notice?.kind !== "create-storage" || machine.name !== notice.sandbox) return undefined
    return `Not enough storage to create ${machine.name}. About ${notice.requiredGB} GiB is needed on ${notice.volume}; ${notice.availableGB} GiB is available. No sandbox was created.`
  }
  const isMachineCreated = (machine: SetupMachineConfiguration) => committedWorkspaces.has(machine.id)
  const isMachineRunning = (machine: SetupMachineConfiguration) => workspaces.get(machine.id)?.state === "running"
  const latestDeleteState = useRef({ source, readOnly })
  useEffect(() => { latestDeleteState.current = { source, readOnly } }, [source, readOnly])
  const machineBusyReason = (machine: SetupMachineConfiguration) => sandboxBusyReason(workspaces.get(machine.id))

  function notifyOperationUnavailable() {
    showActionFailure("Sandbox operation unavailable", source.vmOperationsUnavailable ?? "Sandbox operations are unavailable.", undefined, { native: false })
  }

  // Every lifecycle request from this page (row, sandbox page, menus, toasts) goes through the
  // shared guard: unavailable Sandbox operations are reported and memory pressure asks first.
  const guard = lifecycleGuard(source, actions)
  // Notification actions run later: resolve the sandbox and its guard when clicked, so a toast
  // shown before the snapshot refreshed never acts on outdated state.
  const latestLifecycle = useRef({ guard, workspaces })
  useEffect(() => { latestLifecycle.current = { guard, workspaces } })
  function lifecycleLater(workspace: ApplicationWorkspace, action: LifecycleAction, confirmed: boolean) {
    return () => {
      const { guard: current, workspaces: now } = latestLifecycle.current
      const fresh = now.get(workspace.machine.id) ?? workspace
      if (confirmed) current.confirm(fresh, action)
      else current.request(fresh, action)
    }
  }

  /** Work runs on the sandbox or its computer is unreachable, so its settings can't change now. */
  function changesBlocked(workspace: ApplicationWorkspace) {
    return workspaceAvailability(workspace, source).busy || Boolean(workspace.computer && !workspace.computer.connected)
  }

  /** What a sandbox's Delete dialog states and offers, the same from its row and its page. */
  function deleteDetails(workspace: ApplicationWorkspace): DeleteSandboxDetails {
    const { machine } = workspace
    const readStorage = actions.readWorkspaceStorage
    return {
      checkpoints: workspace.checkpoints?.length,
      readSize: machine.kind === "vm" && !workspace.computer && readStorage
        ? async () => {
            const storage = await readStorage(machine.id)
            return storage.workspaceHostBytes === null || storage.runtimeHostBytes === null
              ? null : storage.workspaceHostBytes + storage.runtimeHostBytes
          }
        : undefined,
      exportFirst: machine.kind === "vm" && !workspace.computer && exportSandbox
        ? async () => {
            try {
              if (!await exportSandbox(machine.name)) return false
            } catch (error) {
              showActionFailure(`Could not export ${machine.name}`, error, undefined, { native: false })
              return false
            }
            // Export can take minutes. A verified file does not authorize deleting a sandbox
            // that started, disappeared, or became busy while that file was being written.
            const current = latestDeleteState.current
            const fresh = current.source.workspaces.find(item => item.machine.id === machine.id && !item.computer)
            if (!fresh || current.readOnly || current.source.vmOperationsUnavailable || current.source.sandboxConfigurationOperation || workspaceAvailability(fresh, current.source).busy || fresh.state === "running" || fresh.freshness === "stale") {
              showActionFailure(`Could not delete ${machine.name}`, "The sandbox changed while exporting. Review its current state before deleting it. Your export is saved.", undefined, { native: false })
              return false
            }
            return true
          }
        : undefined,
    }
  }

  /** Re-submits a failed lifecycle action, guarded like any other request. */
  function lifecycleRetry(workspace: ApplicationWorkspace): (() => void) | undefined {
    const action = workspace.lifecycleFailureAction ?? "start"
    if (readOnly || !workspace.lifecycleFailure || action === "dismiss-error") return undefined
    // The failed request was already confirmed, so Retry asks nothing again.
    return lifecycleLater(workspace, action, true)
  }

  /** Why an account migration cannot be requested for this sandbox right now. */
  function migrationBlocked(workspace: ApplicationWorkspace): string | undefined {
    const { computer } = workspace
    if (computer && !computer.connected) return `${computer.name} is offline. Reconnect it to migrate this sandbox.`
    if (computer?.busy) return `${computer.name} is updating. Wait before migrating this sandbox.`
    if (!computer && source.vmOperationsUnavailable) return source.vmOperationsUnavailable
    if (!computer && source.runtimeRepair) return "Resolve the system issue first."
    if (!computer && configurationOperation) return "Wait for sandbox changes to finish."
    if (workspaceAvailability(workspace, source).busy) return "Wait for the current operation to finish."
    if (workspace.freshness === "stale") return "Silo could not refresh this sandbox’s status."
    return undefined
  }

  /** Migrate a sandbox to the silo account; progress shows in the operation queue. */
  function migrateAccount(workspace: ApplicationWorkspace) {
    const { machine, computer } = workspace
    const target = workspaceTarget(workspace)
    return runAccountMigration({
      id: `account-migration:${computer?.id ?? ""}:${machine.id}`,
      sandbox: machine.name,
      computerName: computer?.name,
      noticeSandbox: { id: machine.id, name: machine.name },
      migrate: () => actions.migrateAccount!(target),
      successAction: { label: "Start", onClick: lifecycleLater(workspace, "start", false) },
    })
  }

  /** The migration controls of a sandbox that still uses the old account layout. */
  function accountMigrationControls(workspace: ApplicationWorkspace): SandboxDetailControls["accountMigration"] {
    if (readOnly || !workspace.accountMigration || !actions.planAccountMigration || !actions.migrateAccount) return undefined
    const target = workspaceTarget(workspace)
    return {
      disabledReason: migrationBlocked(workspace),
      plan: () => actions.planAccountMigration!(target),
      migrate: () => migrateAccount(workspace),
    }
  }

  /** A sandbox's ⋯ menu actions and popovers, built once for its list row and its page. The
   * page and the list append their own Edit, Duplicate, Add Linux desktop and Delete items. */
  function sandboxMenu(workspace: ApplicationWorkspace): { items: MenuAction[]; popovers?: MenuPopovers } {
    const { machine } = workspace
    const target = workspaceTarget(workspace)
    const availability = workspaceAvailability(workspace, source)
    const stale = workspace.freshness === "stale"
    const vm = machine.kind === "vm"
    const local = !workspace.computer
    const restartCheck = guard.check(workspace, "restart")
    const restartPrompt = restartCheck.kind === "confirm" && availability.canRestart && !readOnly ? restartCheck.prompt : undefined
    const migration = workspace.accountMigration?.status === "running" ? undefined : accountMigrationControls(workspace)
    const items: MenuAction[] = [
      ...(migration ? [{ label: "Migrate to the silo account…", icon: UserRoundCog, accessibleLabel: `Migrate ${machine.name} to the silo account`, disabled: Boolean(migration.disabledReason), tooltip: migration.disabledReason, popover: "account-migration" }] : []),
      ...(vm && machine.desktop && actions.openDesktop ? [{ label: "Open Linux desktop", icon: Monitor, accessibleLabel: `Open ${machine.name} desktop`, disabled: configurationLocked || availability.busy || Boolean(workspace.computer && stale), onSelect: () => { void actions.openDesktop!(target) } }] : []),
      restartPrompt
        ? { label: "Restart…", icon: RotateCw, accessibleLabel: `Restart ${machine.name}`, popover: "restart" }
        : { label: "Restart", icon: RotateCw, accessibleLabel: `Restart ${machine.name}`, disabled: readOnly || !availability.canRestart, tooltip: readOnly || availability.canRestart ? undefined : availability.reasons.restart, onSelect: () => guard.request(workspace, "restart") },
      // Checkpoints and Storage open the page's tabs, which disable their own actions as needed.
      ...(vm ? [{ label: "Checkpoints", icon: History, accessibleLabel: `Checkpoints for ${machine.name}`, onSelect: () => openSandbox(machine.id, "checkpoints") }] : []),
      ...(vm && actions.forkCheckpoint ? [{ label: "Fork…", icon: GitFork, accessibleLabel: `Fork ${machine.name}`, disabled: forkDisabled(workspace), popover: "fork" }] : []),
      ...(vm && local && actions.readWorkspaceStorage ? [{ label: "Storage", icon: HardDrive, accessibleLabel: `Storage for ${machine.name}`, onSelect: () => openSandbox(machine.id, "storage") }] : []),
      ...(vm && local && exportSandbox ? [{ label: "Export…", icon: Download, accessibleLabel: `Export ${machine.name}`, disabled: configurationLocked || availability.busy || transferBusy || stale, onSelect: () => exportSandbox(machine.name) }] : []),
    ]
    const popovers: MenuPopovers = { ...forkPopovers(workspace) }
    if (migration) popovers["account-migration"] = close => <AccountMigrationBody sandboxName={machine.name} computerName={workspace.computer?.name} plan={migration.plan} onMigrate={migration.migrate} onClose={close} />
    if (restartPrompt) popovers.restart = close => <ConfirmBody tone={restartPrompt.tone} title={restartPrompt.title} description={restartPrompt.description} confirmLabel={restartPrompt.confirmLabel} onClose={close} onConfirm={lifecycleLater(workspace, "restart", true)} />
    return { items, popovers }
  }

  // Lifecycle failures and cancellations arrive from the backend as workspace state. Toast each
  // new one (both the list and the detail page render from here); failures already present at
  // first load keep only their row state label.
  const seenLifecycleFailures = useRef<Map<string, string> | null>(null)
  const lifecycleToasts = useEffectEvent((all: ApplicationWorkspace[]) => {
    const current = new Map<string, string>()
    for (const workspace of all) {
      if (workspace.lifecycleFailure) current.set(`${workspace.computer?.id ?? ""}:${workspace.machine.id}`, `${workspace.lifecycleFailureAction ?? ""}|${workspace.lifecycleFailure}`)
    }
    const previous = seenLifecycleFailures.current
    seenLifecycleFailures.current = current
    if (!previous) return
    for (const workspace of all) {
      const key = `${workspace.computer?.id ?? ""}:${workspace.machine.id}`
      const signature = current.get(key)
      if (!signature || previous.get(key) === signature) continue
      const action = workspace.lifecycleFailureAction ?? "start"
      const name = workspace.machine.name
      const id = `lifecycle:${key}`
      if (workspace.lifecycleFailureCancelled) {
        showOperationNotice(id, cancelledActionLabel(action))
        continue
      }
      if (action === "dismiss-error") continue
      const verb = action === "restart" ? "restart" : action === "stop" ? "stop" : "start"
      dismissOperationToast(id)
      showOperationFailure(id, `Could not ${verb} ${name}`, { description: workspace.lifecycleFailure ? <ErrorDetails message={workspace.lifecycleFailure} diagnostic={workspace.lifecycleFailureDiagnostic} /> : undefined, retry: lifecycleRetry(workspace), sandbox: name, native: false })
    }
  })
  useEffect(() => { lifecycleToasts(source.workspaces) }, [source.workspaces])

  // Checkpoint operations report through one progress notification each (see
  // model/checkpoint-operation-toast). Both the list and the detail page render from here, so
  // the backend stage refinement lives in this single effect. A finished fork is easy to miss
  // (the new sandbox is stopped), so Open jumps to it, resolved fresh at click time.
  useEffect(() => {
    syncCheckpointProgress(source.workspaces, { queue: source.operationQueue, cancel: readOnly ? undefined : actions.cancelOperation })
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [source.workspaces, source.operationQueue])

  // A deleted sandbox takes its notifications with it: their actions (Open, Retry…) would
  // otherwise point at something that no longer exists.
  const knownSandboxes = useRef(new Map<string, { name: string; computerId: string }>())
  useEffect(() => {
    const current = new Map(source.workspaces.map(workspace => [`${workspace.computer?.id ?? ""}:${workspace.machine.id}`, { name: workspace.machine.name, computerId: workspace.computer?.id ?? "" }]))
    for (const [key, known] of knownSandboxes.current) {
      if (current.has(key)) continue
      // A name shared with a sandbox that still exists (e.g. on another computer) keeps its notifications.
      if ([...current.values()].some(other => other.name === known.name)) continue
      dismissSandboxToasts(known.name)
      dismissOperationToast(`lifecycle:${key}`)
    }
    knownSandboxes.current = current
  }, [source.workspaces])

  /** Open the fork `name`, created on the same computer as its source sandbox. */
  function forkOpenAction(name: string, computerId = "") {
    return {
      label: "Open",
      onClick: () => {
        const match = workspacesRef.current.find(({ machine, computer }) => (computer?.id ?? "") === computerId && machine.name === name)
        if (match) openSandbox(match.machine.id)
      },
    }
  }

  function forkCurrentState(workspace: ApplicationWorkspace, name: string) {
    const target = workspaceTarget(workspace)
    void runCheckpointOperation({
      id: `checkpoint:${target}:fork`,
      kind: "fork",
      target,
      sandbox: [workspace.machine.name, name],
      noticeSandbox: { id: workspace.machine.id, name: workspace.machine.name },
      title: `Creating fork ${name}`,
      run: () => actions.forkCheckpoint!(target, null, name),
      success: { title: "Fork created", description: `${name} is stopped. Start it when you’re ready.`, action: forkOpenAction(name, workspace.computer?.id) },
      failureTitle: `Could not create fork ${name}`,
    })
  }

  // Lifecycle Start/Stop/Restart: a progress notification appears only if the action takes
  // longer than a moment (instant ones never flash) and is dismissed when it finishes; the row
  // state already shows the outcome. Failures keep their own retryable notification.
  const lifecycleProgress = useRef(new Map<string, { timer?: number; shown: boolean; startedAt: number }>())
  const trackLifecycle = useEffectEvent((all: ApplicationWorkspace[]) => {
    const tracked = lifecycleProgress.current
    const live = new Set<string>()
    for (const workspace of all) {
      const action = workspace.lifecycleAction
      if (!action || action === "dismiss-error") continue
      const key = `${workspace.computer?.id ?? ""}:${workspace.machine.id}`
      live.add(key)
      const id = `lifecycle:${key}`
      const name = workspace.machine.name
      const title = action === "restart" ? `Restarting ${name}` : action === "stop" ? `Stopping ${name}` : `Starting ${name}`
      const waiting = !workspace.computer ? waitingOperationForVm(source.operationQueue ?? emptyOperationQueue, workspace.machine.id) : undefined
      const step = waiting && source.operationQueue ? waitingStatusText(source.operationQueue, waiting) : action === "restart" ? "Restarting…" : action === "stop" ? "Stopping…" : "Starting…"
      const existing = tracked.get(key)
      const entry = existing ?? { shown: false, startedAt: Date.now() } as { timer?: number; shown: boolean; startedAt: number }
      const show = () => showOperationProgress(id, { title, step, startedAt: entry.startedAt, sandbox: name })
      if (!existing) {
        tracked.set(key, entry)
        entry.timer = window.setTimeout(() => { entry.shown = true; entry.timer = undefined; show() }, LIFECYCLE_TOAST_DELAY_MS)
      } else if (entry.shown) show()
    }
    for (const [key, entry] of tracked) {
      if (live.has(key)) continue
      if (entry.timer) window.clearTimeout(entry.timer)
      if (entry.shown && !all.some(workspace => `${workspace.computer?.id ?? ""}:${workspace.machine.id}` === key && workspace.lifecycleFailure)) dismissOperationToast(`lifecycle:${key}`)
      tracked.delete(key)
    }
  })
  // Declared before the failure effect so a failed action's Retry toast replaces the dismissal.
  useEffect(() => { trackLifecycle(source.workspaces) }, [source.workspaces, source.operationQueue])
  useEffect(() => () => { for (const entry of lifecycleProgress.current.values()) if (entry.timer) window.clearTimeout(entry.timer) }, [])

  const pickerRoute = `${active}:${selectedId ?? ""}:${activeSandboxTab}`
  const openFolderPicker = (workspaceId: string) => setFolderPicker({ workspaceId, route: pickerRoute })
  // Palette requests open the sandbox's page (the app navigates there first) and then the
  // same folder picker or ⋯ popover its own controls open.
  const [menuRequest, setMenuRequest] = useState<{ token: number; workspaceId: string; panel: string }>()
  const handledSandboxRequest = useRef(0)
  const runSandboxRequest = useEffectEvent((request: SandboxPageRequest) => {
    openSandbox(request.workspaceId)
    if (request.request === "editor") setFolderPicker({ workspaceId: request.workspaceId, route: `${active}:${request.workspaceId}:${activeSandboxTab}` })
    else setMenuRequest({ token: request.token, workspaceId: request.workspaceId, panel: request.request })
    onSandboxRequestHandled?.(request.token)
  })
  useEffect(() => {
    if (!sandboxRequest || handledSandboxRequest.current === sandboxRequest.token) return
    handledSandboxRequest.current = sandboxRequest.token
    runSandboxRequest(sandboxRequest)
  }, [sandboxRequest])
  // The request belongs to the page it was made for: leaving that page drops it, so the
  // popover never reopens when the page is shown again later.
  if (menuRequest && selectedId !== null && selectedId !== menuRequest.workspaceId) setMenuRequest(undefined)
  if (menuRequest && selectedId === null && !sandboxRequest) setMenuRequest(undefined)
  const folderWorkspace = folderPicker && folderPicker.route === pickerRoute ? workspaces.get(folderPicker.workspaceId) : undefined
  const showFolderPicker = Boolean(folderWorkspace && workspaceAvailability(folderWorkspace, source).canOpen)
  // Adjusting state while rendering: the picker is dropped before it could reappear.
  if (folderPicker && !showFolderPicker) setFolderPicker(null)
  if (folderWorkspace && showFolderPicker) {
    return <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <StatusFolderPicker key={folderWorkspace.machine.id} workspace={folderWorkspace} editor={source.preferences.editor} listDirectory={actions.listWorkspaceDirectory} onBack={() => setFolderPicker(null)} onOpen={(path) => actions.openEditor(workspaceTarget(folderWorkspace), path)} />
    </div>
  }

  function detailControls(workspace: ApplicationWorkspace): SandboxDetailControls {
    const machine = workspace.machine
    const target = workspaceTarget(workspace)
    const availability = workspaceAvailability(workspace, source)
    const menu = sandboxMenu(workspace)
    // Edit and Delete are appended and handled in place by the detail page; Duplicate hands
    // off to the list editor for the new sandbox. Editing is offered only when not read-only.
    const editing: SandboxDetailEditing | undefined = readOnly ? undefined : {
      machines,
      computers: source.remoteComputers,
      getComputerId: getMachineComputerId,
      onCommitMachine: commitMachine,
      onDeleteMachine: deleteMachine,
      onMachinesChange: changeMachines,
      validateOperation: validateMachineOperation,
      isMachineCreated,
      isMachineRunning,
    }
    return {
      pageActive: active,
      editing,
      onDuplicate: readOnly ? undefined : () => requestDuplicate(machine.id),
      onNavigate,
      onBack: closeSandbox,
      activeTab: activeSandboxTab,
      onSelectTab: selectSandboxTab,
      readOnly,
      configurationLocked,
      workspaceOperationBusy: availability.busy,
      changesBlocked: changesBlocked(workspace),
      menuRequest: menuRequest?.workspaceId === workspace.machine.id ? menuRequest : undefined,
      deleteDetails: deleteDetails(workspace),
      canOpen: availability.canOpen && !readOnly,
      canStart: availability.canStart && !readOnly,
      canStop: availability.canStop && !readOnly,
      disabledReasons: readOnly ? {} : availability.reasons,
      menuActions: menu.items,
      popovers: menu.popovers,
      onTerminal: () => actions.openTerminal(target),
      onEditor: () => openFolderPicker(machine.id),
      lifecycleGuard: guard,
      onCheckpointExport: exportSandbox ? (checkpoint: WorkspaceCheckpoint) => exportSandbox(machine.name, { id: checkpoint.id, name: checkpoint.name }) : undefined,
      checkpointExportDisabled: transferBusy || backup?.state.availability === "unavailable",
      onCheckpointForkedAction: (name: string) => forkOpenAction(name, workspace.computer?.id),
      onCheckpointRestoredAction: () => ({ label: "Start", onClick: lifecycleLater(workspace, "start", false) }),
      accountMigration: accountMigrationControls(workspace),
    }
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <div className="min-h-0 flex-1">
        {detailWorkspace ? (
          // Keyed per sandbox so edit drafts, delete confirmations and panel state never carry over.
          <SandboxDetailPage key={workspaceTarget(detailWorkspace)} workspace={detailWorkspace} source={source} actions={actions} controls={detailControls(detailWorkspace)} />
        ) : (
          <>
            {connecting && actions.connectComputer && <div className="mb-3"><ConnectComputerForm connect={actions.connectComputer} authorize={actions.authorizeComputer} setupKey={actions.setupComputerKey} onClose={() => setConnecting(false)} /></div>}
            {configurationOperation?.status === "failed" && <div className="mb-3 rounded-md border border-destructive/30 p-3">
              <div role="alert" className="text-sm text-destructive"><ErrorDetails message={configurationOperation.error.message} diagnostic={configurationFailureDiagnostic(configurationOperation)} fallbackSummary="Sandbox changes failed." /></div>
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
              getComputerId={getMachineComputerId}
              onConnectComputer={actions.connectComputer ? () => setConnecting(true) : undefined}
              onImportSandbox={importSandbox}
              importPopover={importSandbox ? importPopover : undefined}
              onCommitMachine={commitMachine}
              onDeleteMachine={deleteMachine}
              isMachineCreated={isMachineCreated}
              isMachineRunning={isMachineRunning}
              getMachineBusyReason={machineBusyReason}
              editorDraftKey="sandbox-list"
              // New sandboxes fit this computer; remote computers do not report capacity yet.
              getHostCapacity={(computerId) => computerId ? undefined : hostCapacityFrom(source.hostCapacity)}
              onMachinesChange={changeMachines}
              interactionDisabled={configurationLocked}
              validateOperation={validateMachineOperation}
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
                    openable: committedWorkspaces.has(machine.id),
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
                const workspaceOperationBusy = Boolean(lifecycle) || Boolean(checkpointOperation)
                const menu = workspace ? sandboxMenu(workspace) : { items: [] }
                const availability = workspace ? workspaceAvailability(workspace, source) : undefined
                const openReason = readOnly || availability?.canOpen ? undefined : availability?.reasons.open
                return {
                  kindBadge: workspace?.computer ? <ComputerBadge computer={workspace.computer} /> : undefined,
                  badge: <>{badge}<SshAccessBadges access={access} stale={sshStale} /></>,
                  popovers: menu.popovers,
                  menuActions: menu.items,
                  deleteDetails: workspace ? deleteDetails(workspace) : undefined,
                  busy: workspaceOperationBusy || Boolean(workspace?.computer?.busy),
                  suppressInteractions: workspace ? changesBlocked(workspace) : false,
                  icon: workspaceOperationBusy ? <ListRowIcon aria-hidden="true"><Loader2 className="size-3.5 animate-spin" /></ListRowIcon> : undefined,
                  iconState: workspace?.lifecycleFailure && !workspace.lifecycleFailureCancelled ? "error" as const : visualState,
                  tone: workspaceOperationBusy ? "starting" as const : workspace?.lifecycleFailure && !workspace.lifecycleFailureCancelled ? "error" as const : workspaceRowTone(workspace),
                  detail: checkpointOperation ? <div role="status" aria-live="polite" aria-atomic="true" className="grid gap-1.5 py-0.5">
                    <p className="truncate text-xs" title={checkpointOperation.stage}>{checkpointOperation.stage}</p>
                    <Progress value={null} aria-label="Checkpoint operation progress" />
                  </div> : (
                    <span className="inline-flex max-w-full items-center gap-1 align-middle">
                      <span className="truncate" title={workspace?.attention?.message}>
                        {workspace ? <WorkspaceStatus workspace={workspace} source={source} readOnly={readOnly} onCancel={actions.cancelOperation} /> : <WorkspaceStateLabel state={state} />}
                        {workspace?.attention && <> · {workspace.attention.message}</>}
                        {workspace?.accountMigration && workspace.accountMigration.status !== "running" && <> · {workspace.accountMigration.status === "failed" ? "Migration to the silo account did not finish" : "Old account layout: migrate it to use it"}</>}
                      </span>
                      {workspace?.canDismissError && state === "failed" && <Button size="xs" variant="ghost" className="h-4 rounded px-1 text-[10px] font-normal" aria-label={`Dismiss ${machine.name} error`} disabled={configurationLocked || workspaceOperationBusy || workspace.freshness === "stale"} onClick={() => actions.dismissWorkspaceError(workspaceTarget(workspace))}>Dismiss</Button>}
                    </span>
                  ),
                  actions: <>
                    <DisabledReason reason={openReason}><SandboxAction label={`Open ${machine.name} in ${source.preferences.terminal}`} disabled={readOnly || !availability?.canOpen} onClick={() => workspace && actions.openTerminal(workspaceTarget(workspace))}><Terminal /></SandboxAction></DisabledReason>
                    <DisabledReason reason={openReason}><SandboxAction label={`Open ${machine.name} in ${source.preferences.editor}`} disabled={readOnly || !availability?.canOpen} onClick={() => openFolderPicker(machine.id)}><Code /></SandboxAction></DisabledReason>
                    {workspace && availability && <WorkspaceActions workspace={workspace} availability={availability} readOnly={readOnly} guard={guard} />}
                  </>,
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}
