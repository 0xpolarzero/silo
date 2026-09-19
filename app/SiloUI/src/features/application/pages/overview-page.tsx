import { useSshAccessRefresh } from "./use-ssh-access-refresh"
import { SshAccessRow, SshAccessBadges } from "./ssh-access-panel"
import { StatusFolderPicker } from "@/features/status-bar/status-folder-picker"
import { workspaceAvailability } from "../model/workspace-availability"
import { ComputerBadge } from "@/features/sandboxes/components/computer-badge"
import { workspaceTarget } from "../model/remote-computers"
import { ConnectComputerForm } from "../components/remote-computers-settings"
import { ChevronDown, CircleAlert, Code, Loader2, Monitor, Play, RotateCw, Square, Terminal, TriangleAlert } from "lucide-react"
import { useState } from "react"

import { ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { setupMachineConfigurationSchema, type SetupMachineConfiguration, type SiloProgressEvent } from "@/contracts/silo"
import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import type {
  ApplicationActions,
  ApplicationSource,
  ApplicationWorkspace,
  SandboxConfigurationOperation,
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
    && operation.error.workspace === candidateName

  if (errorTargetsWorkspace) {
    return {
      status: "failed",
      message: operation.error.message,
      recovery: operation.error.recovery ?? undefined,
      retryable: operation.error.retryable,
    }
  }
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
  onMachinesChange,
  newSandboxRequest,
  onNewSandboxRequestHandled,
}: {
  active?: boolean
  readOnly?: boolean
  newSandboxRequest?: number
  onNewSandboxRequestHandled?: (id: number) => void
  source: ApplicationSource
  actions: ApplicationActions
  onMachinesChange: (machines: SetupMachineConfiguration[]) => void
}) {
  useSshAccessRefresh(readOnly ? undefined : actions.refreshSshAccess, active)
  const [expandedSsh, setExpandedSsh] = useState<Set<string>>(() => new Set())
  const [folderWorkspaceId, setFolderWorkspaceId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [pendingStart, setPendingStart] = useState<string | null>(null)
  const [operationUnavailable, setOperationUnavailable] = useState(false)
  const visibleWorkspaces = displayWorkspaces(source)
  const workspaces = new Map(visibleWorkspaces.map((workspace) => [workspace.machine.id, workspace]))
  const committedWorkspaces = new Map(source.workspaces.map((workspace) => [workspace.machine.id, workspace]))
  const machines = visibleWorkspaces.map(({ machine }) => machine)
  const configurationOperation = source.sandboxConfigurationOperation
  const configurationLocked = readOnly || configurationOperation !== null
  const localMachines = machines.filter(machine => !workspaces.get(machine.id)?.computer)
  function updateLocal(machine: SetupMachineConfiguration, original?: SetupMachineConfiguration) {
    onMachinesChange(original ? localMachines.map(item => item.id === original.id ? machine : item) : [...localMachines, machine])
  }

  const folderWorkspace = folderWorkspaceId ? workspaces.get(folderWorkspaceId) : undefined
  if (folderWorkspace && workspaceAvailability(folderWorkspace, source).canOpen) {
    return <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <StatusFolderPicker key={folderWorkspace.machine.id} workspace={folderWorkspace} editor={source.preferences.editor} listDirectory={actions.listWorkspaceDirectory} onBack={() => setFolderWorkspaceId(null)} onOpen={(path) => actions.openEditor(workspaceTarget(folderWorkspace), path)} />
    </div>
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <div className="min-h-0 flex-1">
        {connecting && actions.connectComputer && <div className="mb-3"><ConnectComputerForm connect={actions.connectComputer} authorize={actions.authorizeComputer} setupKey={actions.setupComputerKey} onClose={() => setConnecting(false)} /></div>}
        <MachineList
          newSandboxRequest={readOnly ? undefined : newSandboxRequest}
          onNewSandboxRequestHandled={onNewSandboxRequestHandled}
          machines={machines}
          computers={source.remoteComputers}
          getComputerId={machine => workspaces.get(machine.id)?.computer?.id}
          onConnectComputer={actions.connectComputer ? () => setConnecting(true) : undefined}
          onCommitMachine={actions.saveRemoteMachine ? async (machine, original, computerId) => {
            if (computerId) await actions.saveRemoteMachine!(computerId, machine, original)
            else updateLocal(machine, original)
          } : undefined}
          onDeleteMachine={actions.deleteRemoteMachine ? async machine => {
            const computer = workspaces.get(machine.id)?.computer
            if (computer) {
              if (!computer.connected) throw new Error("This computer is unavailable. Reconnect before deleting its VM.")
              await actions.deleteRemoteMachine!(computer.id, machine)
            } else {
              onMachinesChange(localMachines.filter(item => item.id !== machine.id))
            }
          } : undefined}
          isMachineCreated={(machine) => committedWorkspaces.has(machine.id)}
          isMachineRunning={(machine) => workspaces.get(machine.id)?.state === "running"}
          onMachinesChange={(next) => {
            if (source.vmOperationsUnavailable) setOperationUnavailable(true)
            else onMachinesChange(next.filter(machine => !workspaces.get(machine.id)?.computer))
          }}
          interactionDisabled={configurationLocked}
          validateOperation={(machine, isNew, computerId) => {
            const computer = workspaces.get(machine.id)?.computer ?? source.remoteComputers?.find(computer => computer.id === computerId)
            if (computer) return computer.busy ? "This computer is applying VM changes. Wait for the operation to finish." : computer.connected ? undefined : "This computer is unavailable. Reconnect before changing its VMs."
            if (source.vmOperationsUnavailable) return source.vmOperationsUnavailable
            const notice = source.resourceNotice
            if (!isNew || machine.kind !== "vm" || notice?.kind !== "create-storage" || machine.name !== notice.sandbox) return undefined
            return `Not enough storage to create ${machine.name}. About ${notice.requiredGB} GB is needed on ${notice.volume}; ${notice.availableGB} GB is available. No sandbox was created.`
          }}
          summary={configurationOperation ? <>{source.workspaces.length} configured · Applying sandbox changes</> : undefined}
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
            const sshAvailable = machine.kind === "vm" && workspace && Boolean(source.sshAccess || actions.refreshSshAccess)
            const sshStale = Boolean((source.sshAccessError && !workspace?.computer) || workspace?.computer?.connected === false || workspace?.freshness === "stale")
            const expanded = expandedSsh.has(machine.id)
            const lifecycle = workspace?.lifecycleAction
            const lifecycleLabel = lifecycle === "dismiss-error" ? "Dismissing…" : lifecycle === "restart" ? "Restarting…" : lifecycle === "stop" ? "Stopping…" : "Starting…"
            return {
              kindBadge: workspace?.computer ? <ComputerBadge computer={workspace.computer} /> : undefined,
              badge: <>{badge}<SshAccessBadges access={access} stale={sshStale} /></>,
              menuActions: [...(machine.kind === "vm" && machine.desktop && actions.openDesktop ? [{ label: "Open desktop", icon: Monitor, accessibleLabel: `Open ${machine.name} desktop`, disabled: configurationLocked || Boolean(lifecycle) || Boolean(workspace?.computer && workspace.freshness === "stale"), onSelect: () => { void actions.openDesktop!(workspace ? workspaceTarget(workspace) : machine.name) } }] : []), { label: "Restart", icon: RotateCw, accessibleLabel: `Restart ${machine.name}`, disabled: configurationLocked || Boolean(lifecycle) || Boolean(workspace?.computer && workspace.freshness === "stale") || (state !== "running" && state !== "failed"), onSelect: () => {
                if (!workspace?.computer && source.vmOperationsUnavailable) setOperationUnavailable(true)
                else actions.restartWorkspace(workspace ? workspaceTarget(workspace) : machine.name)
              } }],
              expandedContent: sshAvailable && expanded ? <div id={`ssh-${machine.id}`}><SshAccessRow readOnly={readOnly} embedded workspace={workspace} access={access} save={actions.saveSshAccess} connection={actions.sshConnection} stale={sshStale} /></div> : undefined,
              busy: Boolean(lifecycle) || Boolean(workspace?.computer?.busy),
              suppressInteractions: readOnly || Boolean(lifecycle) || Boolean(workspace?.computer?.busy) || Boolean(workspace?.computer && !workspace.computer.connected),
              icon: lifecycle ? <ListRowIcon aria-hidden="true"><Loader2 className="size-3.5 animate-spin" /></ListRowIcon> : undefined,
              iconState: visualState,
              tone: lifecycle ? "starting" as const : workspaceRowTone(workspace),
              detail: (
                <span className="inline-flex max-w-full items-center gap-1 align-middle">
                  <span className="truncate" title={workspace?.attention?.message}>
                    {workspace?.computer?.busy ? <span role="status">Applying VM changes…</span> : workspace?.computer && !workspace.computer.connected ? <span>Unavailable</span> : lifecycle ? <span role="status" className="text-amber-700 dark:text-amber-400">{lifecycleLabel}</span> : <WorkspaceStateLabel state={state} />}
                    {workspace?.attention && <> · {workspace.attention.message}</>}
                  </span>
                  {workspace?.canDismissError && state === "failed" && <Button size="xs" variant="ghost" className="h-4 rounded px-1 text-[10px] font-normal" aria-label={`Dismiss ${machine.name} error`} disabled={configurationLocked || Boolean(lifecycle) || workspace.freshness === "stale"} onClick={() => actions.dismissWorkspaceError(workspaceTarget(workspace))}>Dismiss</Button>}
                </span>
              ),
              actions: <>
                <SandboxAction label={`Open ${machine.name} in ${source.preferences.terminal}`} disabled={readOnly || !workspace || !workspaceAvailability(workspace, source).canOpen} onClick={() => workspace && actions.openTerminal(workspaceTarget(workspace))}><Terminal /></SandboxAction>
                <SandboxAction label={`Open ${machine.name} in ${source.preferences.editor}`} disabled={readOnly || !workspace || !workspaceAvailability(workspace, source).canOpen} onClick={() => setFolderWorkspaceId(machine.id)}><Code /></SandboxAction>
                {sshAvailable && <SandboxAction label={`SSH controls for ${machine.name}`} className="w-auto gap-0.5 px-1.5 text-[11px]" aria-expanded={expanded} aria-controls={`ssh-${machine.id}`} onClick={() => setExpandedSsh(current => { const next = new Set(current); if (next.has(machine.id)) next.delete(machine.id); else next.add(machine.id); return next })}>SSH<ChevronDown className={`size-2.5 transition-transform ${expanded ? "rotate-180" : ""}`} /></SandboxAction>}
                <WorkspaceActions target={workspace && workspaceTarget(workspace)} machine={machine} state={state} actions={{
                ...actions,
                startWorkspace: (name) => {
                  if (!workspace?.computer && source.vmOperationsUnavailable) setOperationUnavailable(true)
                  else if (source.resourceNotice?.kind === "start-memory" && source.resourceNotice.sandbox === name) setPendingStart(name)
                  else actions.startWorkspace(name)
                },
                stopWorkspace: (name) => !workspace?.computer && source.vmOperationsUnavailable ? setOperationUnavailable(true) : actions.stopWorkspace(name),
                restartWorkspace: (name) => !workspace?.computer && source.vmOperationsUnavailable ? setOperationUnavailable(true) : actions.restartWorkspace(name),
              }} disabled={configurationLocked || Boolean(lifecycle) || Boolean(workspace?.computer && workspace.freshness === "stale")} />
              </>,
            }
          }}
        />
        {pendingStart && source.resourceNotice?.kind === "start-memory" && <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[.07] p-3" role="status">
          <div className="flex gap-2"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden="true" /><div><p className="text-xs font-medium">Starting {pendingStart} may slow this computer</p><p className="mt-1 text-[11px] text-muted-foreground">Silo found high memory pressure now. This VM can use up to {source.resourceNotice.memoryGiB} GB. Close memory-heavy apps, or start anyway.</p></div></div>
          <div className="mt-2 flex justify-end gap-1"><Button type="button" variant="ghost" size="xs" onClick={() => setPendingStart(null)}>Cancel</Button><Button type="button" variant="outline" size="xs" onClick={() => { actions.startWorkspace(pendingStart); setPendingStart(null) }}>Start anyway</Button></div>
        </div>}
        {operationUnavailable && source.vmOperationsUnavailable && <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/[.06] p-3" role="alert"><div className="flex gap-2"><CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-xs font-medium">VM operation unavailable</p><p className="mt-1 text-[11px] text-muted-foreground">{source.vmOperationsUnavailable}</p></div></div><div className="mt-2 flex justify-end"><Button variant="ghost" size="xs" onClick={() => setOperationUnavailable(false)}>Dismiss</Button></div></div>}
      </div>
    </div>
  )
}
