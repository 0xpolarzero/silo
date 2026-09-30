import { workspaceStorageStateSchema } from "@/features/application/model/workspace-storage"
import { isUnsupportedRemote, logPageSchema } from "@/features/application/model/logs"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useSyncExternalStore } from "react"
import { z } from "zod"
import { showOperationFailure } from "@/lib/operation-toast"

import { siloProgressEventSchema, setupMachineConfigurationSchema, type SetupMachineConfiguration, type SiloProgressEvent, type SetupMachineConfigurationRequest, type SetupQueueItemID } from "@/contracts/silo"
import type { OnboardingCompletionRequest, OnboardingSource } from "@/features/onboarding/model/onboarding-source"
import type { SshAccessWorkspace, SshAccessState, NetworkState, ApplicationActions, ApplicationPort, ApplicationSource, ApplicationWorkspace, SecretConfigurationRequest } from "@/features/application/model/application-source"
import { operationQueueSchema, isCancelledError, type OperationQueue } from "@/features/application/model/operation-queue"
import { deriveMachineChanges, isStaleConfigurationError, type MachineConfigurationChange } from "@/features/application/model/machine-change"
import type { BackupArchive, BackupController, BackupOperation, BackupState } from "@/features/application/model/backup-source"
import type { WorkspaceCheckpointOperation } from "@/features/application/model/checkpoint-source"
import type { StatusBarActions, StatusBarRoute } from "@/features/status-bar/status-bar-types"

import { remoteComputerSchema, remoteManagementSchema, remoteWorkspaceTarget, parseRemoteWorkspaceTarget, workspaceTarget, type RemoteComputer, type RemoteManagement } from "@/features/application/model/remote-computers"

type EventHandler = (event?: { payload: unknown }) => void

export interface ProductionBridge {
  invoke: <T>(command: string, arguments_?: Record<string, unknown>) => Promise<T>
  listen: (event: string, handler: EventHandler) => Promise<() => void>
}

const bridge: ProductionBridge = {
  invoke: (command, arguments_) => invoke(command, arguments_),
  listen: (event, handler) => listen(event, handler),
}

const sshAccessShape = z.object({ workspaces: z.array(z.object({
  workspace: z.string(), enabled: z.boolean(), port: z.number().int(), bindAddress: z.string(), keys: z.array(z.string()),
  state: z.enum(["disabled", "waiting", "listening", "error"]), message: z.string().nullable(), fingerprint: z.string().nullable(), computerName: z.string(), addresses: z.array(z.string()),
})) })

const githubStateShape = z.object({
  personalToken: z.object({ state: z.enum(["connected", "disconnected"]), saved: z.boolean(), account: z.string().optional(), message: z.string().optional() }).optional(),
  policyRevision: z.number().int().nonnegative().optional(),
  state: z.enum(["disconnected", "connecting", "connected"]),
  account: z.string().nullish().transform((value) => value ?? undefined),
  accessEnabled: z.boolean().optional(),
  hostIdentity: z.object({ name: z.string(), email: z.string() }).nullable().optional(),
  repositoryCatalog: z.array(z.string()).optional(),
  repositoryCatalogStatus: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available") }),
    z.object({ status: z.literal("unavailable"), message: z.string(), canRetry: z.boolean() }),
  ]).optional(),
  workspaces: z.array(z.object({
    workspace: z.string(), identity: z.object({ name: z.string(), email: z.string(), apply: z.boolean() }),
    authenticationMethod: z.enum(["oauth", "token"]).optional(),
    repositoryMode: z.enum(["selected", "all"]).default("selected"), allRepositoriesAllowChanges: z.boolean().default(false),
    repositories: z.array(z.object({ repository: z.string(), allowPushes: z.boolean() })),
  })).optional(),
  workspaceOperations: z.array(z.discriminatedUnion("status", [
    z.object({ workspace: z.string(), status: z.literal("applying"), message: z.string() }),
    z.object({ workspace: z.string(), status: z.literal("succeeded"), message: z.string() }),
    z.object({ workspace: z.string(), status: z.literal("failed"), message: z.string(), canRetry: z.literal(true), diagnosticDetails: z.string().optional() }),
  ])).optional(),
})

const directoryPageShape = z.object({
  snapshotId: z.string().min(1),
  entries: z.array(z.object({ name: z.string().min(1), path: z.string().startsWith("/workspace/"), kind: z.enum(["folder", "file", "symlink"]) }).strict()).max(200),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict()

const secretShape = z.object({
  id: z.string(), name: z.string(), workspaces: z.array(z.string()), allowedDomains: z.array(z.string()),
  state: z.enum(["active", "applying", "restart-required"]), pendingWorkspaces: z.array(z.string()).optional(),
  error: z.string().nullish().transform((value) => value ?? undefined), removing: z.boolean().optional(),
})

const checkpointShape = z.object({
  id: z.string().min(1), name: z.string().min(1),
  // The Rust checkpoint journal stores Unix milliseconds (the same u64
  // contract as activity timestamps); normalize at the native boundary for
  // the UI's ISO timestamp model. String values remain accepted for remotes.
  createdAt: z.union([
    z.string().datetime(),
    z.number().int().nonnegative().max(8.64e15).transform(value => new Date(value).toISOString()),
  ]),
  scope: z.enum(["full", "disk"]), reason: z.enum(["manual", "before-restore"]),
  sizeBytes: z.number().int().nonnegative().optional(),
})
const checkpointOperationShape = z.object({
  kind: z.enum(["capture", "fork", "restore"]), status: z.enum(["running", "failed"]),
  stage: z.string(), error: z.string().optional(),
})
const pendingCheckpointRestoreShape = z.object({
  checkpointId: z.string().min(1), sourceWorkspace: z.string().min(1), state: z.enum(["full", "disk"]),
})

const applicationSourceShape = z.object({
  runtimeRepair: z.unknown().nullable(),
  workspaces: z.array(z.object({
    machine: z.object({ id: z.string().min(1), kind: z.enum(["vm", "ssh"]), name: z.string().min(1) }).passthrough(),
    purpose: z.string(),
    state: z.enum(["running", "starting", "stopped", "failed"]),
    stateDetail: z.string(),
    canDismissError: z.boolean().optional(),
    lifecycleFailure: z.string().optional(),
    freshness: z.enum(["fresh", "stale"]),
    host: z.string(),
    repositories: z.array(z.unknown()), files: z.array(z.unknown()), ports: z.array(z.unknown()), logs: z.array(z.unknown()),
    githubRepositories: z.array(z.string()), secretNames: z.array(z.string()),
    checkpoints: z.array(checkpointShape).optional(),
    checkpointOperation: checkpointOperationShape.nullable().optional(),
    pendingCheckpointRestore: pendingCheckpointRestoreShape.nullable().optional(),
  }).passthrough()),
  activities: z.array(z.unknown()),
  sandboxConfigurationOperation: z.unknown().nullable(),
  repositoryPushOperations: z.array(z.unknown()),
  github: githubStateShape,
  secrets: z.array(secretShape),
  backup: z.object({ lastArchive: z.string(), completedLabel: z.string(), compressedSize: z.string(), destination: z.string() }),
  preferences: z.object({
    terminal: z.string(), editor: z.string(), browser: z.string(), launchAtLogin: z.boolean(),
    startWorkspacesAtLaunch: z.boolean(), reduceMotion: z.boolean(),
  }).passthrough(),
}).passthrough()

const backupArchiveShape = z.object({
  name: z.string().min(1), archivePath: z.string().min(1), completedLabel: z.string(), size: z.string(), destination: z.string(), sandboxes: z.array(z.string()),
}).strict()
const backupPhaseShape = z.object({ title: z.string(), detail: z.string(), tone: z.enum(["waiting", "running", "succeeded", "failed"]) }).strict()
const backupOperationShape = z.discriminatedUnion("kind", [
  z.object({ operation: z.enum(["backup", "restore"]), archive: backupArchiveShape, runningNames: z.array(z.string()), targetName: z.string().optional(), kind: z.literal("running"), progress: z.number().min(0).max(100), indeterminate: z.boolean().optional(), canCancel: z.boolean().optional(), phases: z.array(backupPhaseShape) }).strict(),
  z.object({ operation: z.enum(["backup", "restore"]), archive: backupArchiveShape, runningNames: z.array(z.string()), targetName: z.string().optional(), kind: z.literal("result"), outcome: z.enum(["success", "failed", "restart-required", "cancelled"]), title: z.string(), message: z.string(), detail: z.string().optional() }).strict(),
])
const backupStateShape = z.object({
  snapshotId: z.string(), operationId: z.string().optional(), availability: z.enum(["available", "unavailable"]), availabilityMessage: z.string().optional(),
  requiredSpaceGB: z.number().nonnegative().optional(), availableSpaceGB: z.number().nonnegative().optional(),
  unsupportedStorage: z.object({ sandbox: z.string(), label: z.string() }).strict().optional(),
  destination: z.string().optional(),
  archives: z.array(backupArchiveShape), operation: backupOperationShape.nullable(),
}).strict()
const archiveInspectionShape = z.object({ archive: backupArchiveShape, valid: z.boolean(), reason: z.string().optional() }).strict()

const networkStateShape = z.object({ workspaces: z.array(z.object({
  workspace: z.string(), error: z.string().nullable(), ports: z.array(z.object({
    configuredHostPort: z.number().int().min(1).max(65535).nullable().optional(),
    port: z.number().int().min(1).max(65535), hostPort: z.number().int().min(1).max(65535).nullable(),
    scheme: z.enum(["http", "https"]).nullable(), state: z.enum(["reachable", "waiting", "unpublished", "unknown"]),
    configured: z.boolean(), message: z.string().nullable().optional(),
  })),
})) })

export function parseApplicationSource(input: unknown): ApplicationSource {
  return applicationSourceShape.parse(input) as unknown as ApplicationSource
}

export function parseBackupState(input: unknown): BackupState {
  return backupStateShape.parse(input) as BackupState
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  const text = String(error).trim()
  return text || "The desktop bridge returned an unknown error."
}

function unavailableBackup(message: string): BackupState {
  return { snapshotId: `unavailable:${message}`, availability: "unavailable", availabilityMessage: message, requiredSpaceGB: 0, archives: [], operation: null }
}

export interface ProductionSnapshot {
  savedMachines?: SetupMachineConfiguration[]
  setupQueue: NonNullable<OnboardingSource["setupQueue"]>
  setupStartedAt?: number
  setupFinishedAt?: number
  setupEvents: SiloProgressEvent[]
  setupActivity?: SiloProgressEvent[]
  setupActivityError?: string
  setupCandidate?: SetupMachineConfigurationRequest
  source: ApplicationSource | null
  backup: BackupState
  loading: boolean
  error: string | null
}

type RemoteHost = z.infer<typeof remoteComputerSchema>

/** How long a caller waits for one computer's snapshot before showing its last known state as stale. */
const REMOTE_READ_WAIT_MS = 15_000

/** Push status polling: the normal interval, the backoff ceiling, and unanswered checks before giving up. */
const PUSH_STATUS_INTERVAL_MS = 2_000
const PUSH_STATUS_MAX_INTERVAL_MS = 30_000
const PUSH_STATUS_ATTEMPTS = 8

/** The runtime's "configuration is updating" sentinel, bare or wrapped by a remote bridge. */
export function isUpdateInProgress(cause: unknown) {
  return errorMessage(cause).includes("SILO_SANDBOX_UPDATE_IN_PROGRESS")
}

export function createProductionSource(native: ProductionBridge = bridge) {
  let snapshot: ProductionSnapshot = {
    setupQueue: ["workspaceRun", "workspaceVerify", "identityRun", "identityVerify", "githubRun", "githubVerify", "completion"].map((id) => ({ id: id as SetupQueueItemID, status: "idle" })),
    setupEvents: [],
    source: null,
    backup: unavailableBackup("Backup state has not loaded. No sandbox data changed."),
    loading: true,
    error: null,
  }
  let view = snapshot
  type SetupItem = NonNullable<OnboardingSource["setupQueue"]>[number]
  type SetupJob = { items: SetupItem[]; activityId: string }
  let setupJobs: SetupJob[] = []
  let activeMachineJob: SetupJob | undefined
  let setupTail: Promise<unknown> = Promise.resolve()
  let acceptingSetup = true
  let lastMachineJob: { key: string; promise: Promise<ApplicationSource> } | undefined
  let identityVerificationSequence = 0
  let lastVerificationKey: string | undefined
  let lastGitHubJob: { key: string; promise: Promise<void> } | undefined
  let lastIdentityJob: { key: string; promise: Promise<void> } | undefined
  let activeConfiguration: ApplicationSource["sandboxConfigurationOperation"] = null
  let activeRequestId: string | null = null
  let operationSequence = 0
  let remoteComputers: RemoteComputer[] = []
  let remoteManagement: RemoteManagement | undefined
  let remoteManagementError: string | undefined
  let remoteComputersError: string | undefined
  const remoteSnapshots = new Map<string, ApplicationSource>()
  let remoteHosts: RemoteHost[] = []
  let remoteListRevision = 0
  let remoteListRead: Promise<boolean> | undefined
  let remotePasses = 0
  const remoteRevisions = new Map<string, number>()
  const remoteReads = new Map<string, { repositories: boolean; promise: Promise<void> }>()
  const remoteRepositoryReads = new Set<string>()
  const slowComputers = new Set<string>()
  let remoteTimer: ReturnType<typeof setInterval> | undefined
  let sshAccess: SshAccessState | undefined
  let sshAccessError: string | null = null
  let sshRequest: Promise<void> | undefined
  let sshRevision = 0
  const sshSaveRevisions = new Map<string, number>()
  let network: NetworkState | undefined
  let networkError: string | null = null
  let networkRequest: Promise<void> | undefined
  let networkDirty = false
  let networkRevision = 0
  let operationQueue: OperationQueue | undefined
  let operationQueueRequest: Promise<void> | undefined
  let operationQueueDirty = false
  let disposed = false
  let activeRefreshes = 0
  /** Bumped whenever newer state is published outside a read: reads started earlier are dropped. */
  let refreshSequence = 0
  let readSequence = 0
  let appliedApplicationRead = 0
  let appliedBackupRead = 0
  let refreshRepositoriesOnReturn = false
  let githubMutationSequence = 0
  let githubMutationPending = false
  const unlisten: Array<() => void> = []
  const listeners = new Set<() => void>()
  const pendingWorkspaceActions = new Set<string>()
  const pendingCheckpointOperations = new Map<string, WorkspaceCheckpointOperation>()
  const pushPollTimers = new Set<ReturnType<typeof setTimeout>>()
  const pendingRepositoryPushes = new Map<string, ApplicationSource["repositoryPushOperations"][number]>()
  /** The push whose status polling currently owns each repository key. */
  const activePushes = new Map<string, object>()
  /** Pushes whose status could not be confirmed; shown as "unknown" until dismissed or reported by their host. */
  const unconfirmedPushes = new Map<string, ApplicationSource["repositoryPushOperations"][number]>()
  const pendingLifecycle = new Map<string, "start" | "stop" | "restart" | "dismiss-error">()
  const workspaceFailures = new Map<string, { machineId: string; action: string; message: string; cancelled: boolean }>()
  let pendingBackupOperation = false
  let localBackupOperation: BackupOperation | null = null
  const dismissedBackupResults = new Set<string>()
  let requestedOperation: { operation: "backup" | "restore"; archive: BackupArchive; targetName?: string } | null = null

  /** Identity of one repository's push across native results, pending pushes and dismissals. */
  function pushKey(workspace: string, repositoryPath: string) { return JSON.stringify([workspace, repositoryPath]) }
  function sshOwner(target: string) { return parseRemoteWorkspaceTarget(target)?.hostId ?? "" }
  function unavailableSshRows(hostId: string, computerName: string, message: string): SshAccessWorkspace[] {
    const cached = sshAccess?.workspaces.filter(row => sshOwner(row.workspace) === hostId) ?? []
    const workspaces = hostId ? remoteSnapshots.get(hostId)?.workspaces ?? [] : snapshot.source?.workspaces.filter(w => !w.computer) ?? []
    const rows = new Map(cached.map(row => [row.workspace, row]))
    for (const workspace of workspaces.filter(w => w.machine.kind === "vm")) {
      const target = hostId ? remoteWorkspaceTarget(hostId, workspace.machine.id) : workspace.machine.name
      if (!rows.has(target)) rows.set(target, { workspace: target, enabled: false, port: 2222, bindAddress: "127.0.0.1", keys: [], state: "error", message, fingerprint: null, computerName, addresses: [] })
    }
    return [...rows.values()].map(row => ({ ...row, unavailable: message }))
  }
  function refreshSshAccess(): Promise<void> {
    if (sshRequest) return sshRequest
    const revision = sshRevision
    const computers = [...remoteComputers]
    sshRequest = (async () => {
      const results = await Promise.allSettled([
        native.invoke("read_ssh_access_state").then(value => {
          const state = sshAccessShape.parse(value)
          if (state.workspaces.some(row => sshOwner(row.workspace) !== "")) throw new Error("SSH response belongs to another computer.")
          return state
        }),
        ...computers.map(async computer => {
          if (!computer.connected) throw new Error("Computer is offline.")
          const state = sshAccessShape.parse(await native.invoke("remote_ssh_access_state", { hostId: computer.id }))
          if (state.workspaces.some(row => sshOwner(row.workspace) !== computer.id)) throw new Error("SSH response belongs to another computer.")
          return state
        }),
      ])
      if (disposed || revision !== sshRevision) return
      sshAccessError = results[0].status === "rejected" ? "Could not check SSH access." : null
      sshAccess = { workspaces: results.flatMap((result, index) => {
        if (index === 0) return result.status === "fulfilled" ? result.value.workspaces : unavailableSshRows("", remoteManagement?.name ?? "Silo host", "Could not check SSH access.")
        const computer = computers[index - 1]
        const current = remoteComputers.find(item => item.id === computer.id)
        if (!current) return []
        if (result.status === "fulfilled" && current.connected) return result.value.workspaces
        const unsupported = current.connected && result.status === "rejected" && isUnsupportedRemote(result.reason)
        const message = unsupported
          ? `Update Silo on ${computer.name} to manage SSH access. That version does not support remote SSH management.`
          : `SSH status on ${computer.name} is unavailable. Reconnect and refresh before changing access.`
        return unavailableSshRows(computer.id, computer.name, message)
      }) }
      publish({ ...snapshot })
    })().finally(() => { sshRequest = undefined })
    return sshRequest
  }

  // An event that arrives during a read marks it dirty so one re-read follows
  // instead of the change being lost behind the in-flight result.
  function refreshNetwork(): Promise<void> {
    if (networkRequest) { networkDirty = true; return networkRequest }
    networkRequest = (async () => { do {
      networkDirty = false
      const revision = networkRevision
      try {
        const local = networkStateShape.parse(await native.invoke("read_network_state"))
        const remotes = await Promise.all(remoteComputers.map(async computer => {
          const unavailable = (error: string) => (remoteSnapshots.get(computer.id)?.workspaces ?? []).map(w => ({ workspace: remoteWorkspaceTarget(computer.id, w.machine.id), ports: [], error }))
          // An offline computer would only cost a connection timeout on every poll.
          if (!computer.connected) return unavailable(`${computer.name} is unavailable. Reconnect to see network services.`)
          try { return networkStateShape.parse(await native.invoke("remote_network_state", { hostId: computer.id })).workspaces }
          catch (cause) {
            return unavailable(isUnsupportedRemote(cause) ? `Update Silo on ${computer.name} to see network services.` : errorMessage(cause))
          }
        }))
        const result = { workspaces: [...local.workspaces, ...remotes.flat()] }
        if (revision !== networkRevision || disposed) continue
        network = result; networkError = null
      } catch {
        if (revision !== networkRevision || disposed) continue
        networkError = "Could not check network services."
      }
      publish({ ...snapshot })
    } while (networkDirty && !disposed) })().finally(() => { networkRequest = undefined })
    return networkRequest
  }
  function refreshOperationQueue(): Promise<void> {
    if (operationQueueRequest) { operationQueueDirty = true; return operationQueueRequest }
    operationQueueRequest = (async () => { do {
      operationQueueDirty = false
      try {
        const next = operationQueueSchema.parse(await native.invoke("read_operation_queue"))
        if (disposed) return
        operationQueue = next
        publish({ ...snapshot })
      } catch {
        // A read failure leaves the last queue in place; a later event refetches.
      }
    } while (operationQueueDirty && !disposed) })().finally(() => { operationQueueRequest = undefined })
    return operationQueueRequest
  }

  async function changeNetwork(command: string, arguments_: Record<string, unknown>) {
    const revision = ++networkRevision
    const remote = typeof arguments_.workspace === "string" ? parseRemoteWorkspaceTarget(arguments_.workspace) : undefined
    const { workspace: _workspace, ...rest } = arguments_
    const result = networkStateShape.parse(await native.invoke(remote ? `remote_${command}` : command, remote ? { ...rest, ...remote } : arguments_))
    if (revision !== networkRevision || disposed) return
    const retained = network?.workspaces.filter(row => remote ? !row.workspace.startsWith(`silo-remote:${remote.hostId}:`) : row.workspace.startsWith("silo-remote:")) ?? []
    network = { workspaces: [...retained, ...result.workspaces] }; networkError = null
    publish({ ...snapshot })
  }

  async function changeSecret(command: string, arguments_: Record<string, unknown>) {
    const secrets = z.array(secretShape).parse(await native.invoke(command, arguments_))
    ++refreshSequence
    if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, secrets } })
    void refresh()
  }

  // `snapshot` is the base state: the local application source as last read or
  // returned by a mutation, without frontend overlays. `view` is what subscribers
  // see: the base plus remote computers, network ports, and pending, failed and
  // unconfirmed actions. It is derived once per publish and never written back,
  // so an overlay disappears as soon as its reason does.
  function publish(next: ProductionSnapshot) {
    if (disposed) return
    snapshot = next
    view = derive(next)
    listeners.forEach((listener) => listener())
  }

  function derivePorts(row: NetworkState["workspaces"][number] | undefined, reachable: boolean): ApplicationPort[] {
    return (row?.ports ?? []).map(port => ({ port: port.port, listening: reachable && !networkError && !row?.error && port.state === "reachable", hostPort: port.hostPort, scheme: port.scheme, configured: port.configured }))
  }

  function withPendingCheckpoint(workspace: ApplicationWorkspace, target: string): ApplicationWorkspace {
    const pending = pendingCheckpointOperations.get(target)
    return pending ? { ...workspace, checkpointOperation: workspace.checkpointOperation?.status === "running" ? workspace.checkpointOperation : pending } : workspace
  }

  function derive(base: ProductionSnapshot): ProductionSnapshot {
    let operation = base.backup.operation
    if (operation?.kind === "result" && dismissedBackupResults.has(JSON.stringify(operation))) operation = null
    if (localBackupOperation && operation !== localBackupOperation) {
      if (!operation) operation = localBackupOperation
      else {
        localBackupOperation = null
        if (operation.kind === "running") dismissedBackupResults.clear()
      }
    }
    if (operation?.kind === "result") requestedOperation = null
    const next = { ...base, backup: { ...base.backup, operation } }
    if (!base.source) return next
    const networkRows = new Map((network?.workspaces ?? []).map(row => [row.workspace, row]))
    const workspaces = base.source.workspaces.filter(workspace => !workspace.computer).map(workspace => ({
      ...withPendingCheckpoint(workspace, workspace.machine.name),
      ports: derivePorts(networkRows.get(workspace.machine.name), true),
    }))
    let pushes = base.source.repositoryPushOperations.filter(push => !parseRemoteWorkspaceTarget(push.workspace))
    const activities = base.source.activities.filter(activity => !activity.id.startsWith("silo-remote-activity:"))
    for (const computer of remoteComputers) {
      const owner = remoteSnapshots.get(computer.id)
      if (!owner) continue
      const vms = new Map(owner.workspaces.filter(workspace => workspace.machine.kind === "vm").map(workspace => [workspace.machine.name, workspace]))
      const sshNames = new Set(owner.workspaces.filter(workspace => workspace.machine.kind === "ssh").map(workspace => workspace.machine.name))
      const slow = slowComputers.has(computer.id)
      for (const workspace of vms.values()) {
        const target = remoteWorkspaceTarget(computer.id, workspace.machine.id)
        workspaces.push({
          ...withPendingCheckpoint(workspace, target),
          machine: { ...workspace.machine, id: target },
          computer: { ...computer, vmId: workspace.machine.id },
          ports: derivePorts(networkRows.get(target), computer.connected),
          freshness: computer.connected && !computer.busy && !slow ? workspace.freshness : "stale",
          stateDetail: computer.busy || (computer.connected && slow) ? "Refreshing status" : computer.connected ? workspace.stateDetail : "Computer unavailable",
        })
      }
      for (const push of owner.repositoryPushOperations) {
        const workspace = vms.get(push.workspace)
        if (workspace) pushes.push({ ...push, workspace: remoteWorkspaceTarget(computer.id, workspace.machine.id) })
      }
      for (const activity of owner.activities) {
        if (activity.workspace && sshNames.has(activity.workspace)) continue
        activities.push({ ...activity,
          id: `silo-remote-activity:${encodeURIComponent(computer.id)}:${encodeURIComponent(activity.id)}`,
          detail: `${computer.name}: ${activity.detail}`,
          workspace: activity.workspace ? remoteWorkspaceTarget(computer.id, vms.get(activity.workspace)?.machine.id ?? activity.workspace) : undefined,
        })
      }
    }
    if (pendingRepositoryPushes.size || unconfirmedPushes.size) {
      // A push whose sandbox (or computer) is gone has nothing left to show or poll.
      const targets = new Set(workspaces.map(workspaceTarget))
      for (const [key, push] of pendingRepositoryPushes) if (!targets.has(push.workspace)) { pendingRepositoryPushes.delete(key); activePushes.delete(key) }
      for (const [key, push] of unconfirmedPushes) if (!targets.has(push.workspace)) unconfirmedPushes.delete(key)
      // The owning host reporting this very push replaces its unconfirmed result.
      for (const [key, unconfirmed] of unconfirmedPushes) if (pushes.some(push => pushKey(push.workspace, push.repositoryPath) === key && push.operationId === unconfirmed.operationId)) unconfirmedPushes.delete(key)
      // Remote polling can return a snapshot captured before the push started.
      // Keep the operation loading until its host supplies a terminal result.
      pushes = [
        ...pushes.filter(push => !pendingRepositoryPushes.has(pushKey(push.workspace, push.repositoryPath)) && !unconfirmedPushes.has(pushKey(push.workspace, push.repositoryPath))),
        ...pendingRepositoryPushes.values(),
        ...unconfirmedPushes.values(),
      ]
    }
    return { ...next, source: { ...base.source,
      remoteComputers, remoteManagement, remoteManagementError, remoteComputersError, network, networkError, sshAccess, sshAccessError, operationQueue,
      repositoryPushOperations: pushes,
      activities,
      workspaces: workspaces.map(({ lifecycleAction: _reported, ...workspace }) => {
        const target = workspaceTarget(workspace)
        const failure = workspaceFailures.get(target)
        const action = pendingLifecycle.get(target)
        // A resubmitted lifecycle action supersedes the last failure or cancellation
        // until it reports its own result.
        const current = action ? { ...workspace, lifecycleFailure: undefined, lifecycleFailureAction: undefined, lifecycleFailureCancelled: undefined } : workspace
        return { ...current,
          ...(failure?.machineId === workspace.machine.id && { lifecycleFailure: failure.message, lifecycleFailureAction: failure.action as "start" | "stop" | "restart" | "dismiss-error", lifecycleFailureCancelled: failure.cancelled }),
          ...(action && { lifecycleAction: action }),
        }
      }),
    } }
  }

  // Mutation responses carry the configuration and VM state but not the enrichment of
  // a full read (D-08): no log output, no repositories, no push operations, and a
  // placeholder GitHub state. Keep those from the state they replace until the full
  // refresh that follows every mutation; the merge stays as a guard once D-08 lands.
  function parseMutationSource(value: unknown, previousSource = snapshot.source): ApplicationSource {
    const parsed = parseApplicationSource(value)
    const previous = new Map((previousSource?.workspaces ?? []).map(workspace => [workspace.machine.id, workspace]))
    const workspaces = parsed.workspaces.map(workspace => ({
      ...workspace,
      logs: workspace.logs.length ? workspace.logs : previous.get(workspace.machine.id)?.logs ?? [],
      repositories: workspace.repositories.length ? workspace.repositories : previous.get(workspace.machine.id)?.repositories ?? [],
    }))
    const repositoryPushOperations = parsed.repositoryPushOperations.length ? parsed.repositoryPushOperations : previousSource?.repositoryPushOperations ?? []
    return { ...parsed, workspaces, repositoryPushOperations, github: mutationGitHub(parsed.github, previousSource?.github) }
  }

  function mutationGitHub(github: ApplicationSource["github"], previous: ApplicationSource["github"] | undefined): ApplicationSource["github"] {
    if (!previous) return github
    // A placeholder has neither a policy revision nor a catalog status (the runtime's
    // unavailable fallback has the latter); an older revision is stale.
    const placeholder = github.policyRevision === undefined && github.repositoryCatalogStatus === undefined
    if (placeholder || (github.policyRevision !== undefined && github.policyRevision < (previous.policyRevision ?? 0))) return previous
    return github.hostIdentity === undefined ? { ...github, hostIdentity: previous.hostIdentity } : github
  }

  function unreadableBackup(message: string): BackupState {
    const state = unavailableBackup(message)
    if (requestedOperation) state.operation = backupFailure(requestedOperation.operation, requestedOperation.archive, message, requestedOperation.targetName)
    return state
  }

  async function readSetupActivity(requestId?: string) {
    const sequence = operationSequence
    try {
      const events = z.array(siloProgressEventSchema).max(2000).parse(await native.invoke("read_setup_activity"))
      if (disposed || sequence !== operationSequence) return
      if (requestId && !events.some((event) => event.requestId === requestId)) return
      publish({ ...snapshot, setupActivity: events, setupActivityError: undefined })
    } catch {
      if (!disposed && sequence === operationSequence) publish({ ...snapshot, setupActivityError: "Saved setup activity could not be loaded. Retry by reopening Silo." })
    }
  }

  // Remote computers refresh independently: a remote snapshot can take minutes, so
  // each computer has at most one read in flight, publishes as soon as it settles,
  // and never holds back another computer's status. Callers wait for a computer at
  // most REMOTE_READ_WAIT_MS; after that it shows its last known state as stale.
  function remoteRevision(hostId: string) { return remoteRevisions.get(hostId) ?? 0 }
  /** Every remote mutation bumps its computer's revision: a read that started earlier is dropped and read again. */
  function bumpRemote(hostId: string) { remoteRevisions.set(hostId, remoteRevision(hostId) + 1) }

  function setComputer(computer: RemoteComputer) {
    const order = remoteHosts.map(host => host.id)
    remoteComputers = [...remoteComputers.filter(item => item.id !== computer.id), computer]
      .sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
  }

  function readComputer(hostId: string, refreshRepositories: boolean): Promise<void> {
    const inFlight = remoteReads.get(hostId)
    // A read already fetching repositories answers this request too; otherwise one
    // follow-up read with repositories is chained after it.
    if (inFlight) { if (refreshRepositories && !inFlight.repositories) remoteRepositoryReads.add(hostId); return inFlight.promise }
    const entry = { repositories: refreshRepositories, promise: Promise.resolve() }
    entry.promise = (async () => {
      for (;;) {
        remoteRepositoryReads.delete(hostId)
        const revision = remoteRevision(hostId)
        let outcome: { source: ApplicationSource } | { cause: unknown }
        try { outcome = { source: parseApplicationSource(await native.invoke("remote_host_snapshot", { hostId, ...(entry.repositories && { refreshRepositories: true }) })) } }
        catch (cause) { outcome = { cause } }
        const host = remoteHosts.find(item => item.id === hostId)
        if (disposed || !host) return
        // A mutation during the read makes this result older than what is shown.
        if (revision === remoteRevision(hostId)) {
          const lastSeen = remoteComputers.find(item => item.id === hostId)?.lastSeen
          slowComputers.delete(hostId)
          if ("source" in outcome) {
            remoteSnapshots.set(hostId, outcome.source)
            setComputer({ ...host, connected: true, lastSeen: Date.now() })
          } else if (isUpdateInProgress(outcome.cause)) setComputer({ ...host, connected: true, busy: true, lastSeen })
          else setComputer({ ...host, connected: false, error: errorMessage(outcome.cause), lastSeen })
          publish({ ...snapshot })
          if (!remoteRepositoryReads.has(hostId)) return
          entry.repositories = true
        }
      }
    })().finally(() => { if (remoteReads.get(hostId) === entry) remoteReads.delete(hostId) })
    remoteReads.set(hostId, entry)
    return entry.promise
  }

  function waitForComputer(hostId: string, read: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const slow = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        const host = remoteHosts.find(item => item.id === hostId)
        if (!disposed && host && remoteReads.get(hostId)?.promise === read && !slowComputers.has(hostId)) {
          slowComputers.add(hostId)
          const known = remoteComputers.find(item => item.id === hostId)
          setComputer({ ...host, connected: known?.connected ?? false, lastSeen: known?.lastSeen, error: `${host.name} is not responding. Showing its last known state.` })
          publish({ ...snapshot })
        }
        resolve()
      }, REMOTE_READ_WAIT_MS)
    })
    return Promise.race([read, slow]).finally(() => clearTimeout(timer))
  }

  /** The computer list; a list read that overlapped a connect or removal is read again. */
  function readHostList(): Promise<boolean> {
    remoteListRead ??= (async () => {
      for (;;) {
        const revision = remoteListRevision
        let hosts: RemoteHost[]
        try { hosts = z.array(remoteComputerSchema).parse(await native.invoke("remote_host_list")) }
        catch (cause) {
          if (disposed) return false
          // The known computers stay listed; the failure is about the list itself.
          remoteComputersError = `Silo could not read its list of computers: ${errorMessage(cause)}`
          publish({ ...snapshot })
          return false
        }
        if (disposed) return false
        if (revision !== remoteListRevision) continue
        remoteComputersError = undefined
        remoteHosts = hosts
        remoteComputers = hosts.flatMap(host => {
          const known = remoteComputers.find(item => item.id === host.id)
          return known ? [{ ...known, name: host.name, address: host.address }] : []
        })
        for (const id of remoteSnapshots.keys()) if (!hosts.some(host => host.id === id)) remoteSnapshots.delete(id)
        for (const id of slowComputers) if (!hosts.some(host => host.id === id)) slowComputers.delete(id)
        publish({ ...snapshot })
        return true
      }
    })().finally(() => { remoteListRead = undefined })
    return remoteListRead
  }

  async function readRemoteManagement() {
    try {
      const management = remoteManagementSchema.parse(await native.invoke("remote_management_status"))
      if (disposed) return
      remoteManagement = management
      remoteManagementError = undefined
    } catch (cause) { remoteManagementError = errorMessage(cause) }
  }

  async function refreshComputers(refreshRepositories = false) {
    remotePasses++
    const [listed] = await Promise.all([readHostList(), readRemoteManagement()])
    if (disposed) return
    if (listed) await Promise.all(remoteHosts.map(host => waitForComputer(host.id, readComputer(host.id, refreshRepositories))))
    if (!snapshot.source && snapshot.error) {
      const source = await unavailableLocalSource(snapshot.error)
      if (!snapshot.source && source) publish({ ...snapshot, source })
    }
    publish({ ...snapshot })
  }

  async function unavailableLocalSource(message: string): Promise<ApplicationSource | null> {
    // A transient read failure never replaces a loaded application with the
    // full-screen error: keep the previous source, marked stale with the error.
    if (!snapshot.source) {
      if (remoteComputers.length === 0) return null
      if (!remoteComputers.some(computer => computer.connected && remoteSnapshots.has(computer.id))) return null
      try { return parseApplicationSource(await native.invoke("read_application_shell", { error: message })) }
      catch { return null }
    }
    return { ...snapshot.source, vmOperationsUnavailable: message,
      workspaces: snapshot.source.workspaces.map(workspace => workspace.computer ? workspace : {
        ...workspace, freshness: "stale", attention: { level: "error", message },
      }),
    }
  }

  async function refresh(refreshRepositories = false) {
    activeRefreshes++
    try { await readSnapshots(refreshRepositories) }
    finally { activeRefreshes-- }
  }

  // Reads may overlap. A read's result is dropped when a mutation published newer
  // state after it started, or when a later read's result is already shown. An
  // UPDATING reply carries no state, so it never displaces an earlier read's result.
  async function readSnapshots(refreshRepositories: boolean) {
    const epoch = refreshSequence
    const sequence = ++readSequence
    const remotePassesAtStart = remotePasses
    const [applicationResult, backupResult] = await Promise.allSettled([
      refreshRepositories ? native.invoke<unknown>("read_application_state", { refreshRepositories: true }) : native.invoke<unknown>("read_application_state"),
      native.invoke<unknown>("read_backup_state"),
    ])
    if (disposed || epoch !== refreshSequence) return
    let source = snapshot.source
    let backup = snapshot.backup
    let error: string | null = null
    let configurationUpdating = false
    if (applicationResult.status === "fulfilled") {
      try { source = parseApplicationSource(applicationResult.value) }
      catch (cause) {
        error = `Silo returned invalid application state: ${errorMessage(cause)}`
        source = await unavailableLocalSource(error)
      }
    } else {
      configurationUpdating = isUpdateInProgress(applicationResult.reason)
      if (!configurationUpdating) {
        error = `Silo could not read application state: ${errorMessage(applicationResult.reason)}`
        source = await unavailableLocalSource(error)
      }
    }
    if (backupResult.status === "fulfilled") {
      try {
        backup = parseBackupState(backupResult.value)
      }
      catch (cause) { backup = unreadableBackup(`Silo returned invalid backup state: ${errorMessage(cause)} Refresh to confirm the operation result.`) }
    } else backup = unreadableBackup(`Silo could not read backup state: ${errorMessage(backupResult.reason)} Refresh to confirm the operation result.`)
    if (disposed || epoch !== refreshSequence) return
    const applicationCurrent = sequence > appliedApplicationRead
    const backupCurrent = sequence > appliedBackupRead
    if (!applicationCurrent && !backupCurrent) return
    if (!applicationCurrent) { source = snapshot.source; error = snapshot.error; configurationUpdating = false }
    else if (!configurationUpdating) appliedApplicationRead = sequence
    if (backupCurrent) appliedBackupRead = sequence
    else backup = snapshot.backup
    // Only a known older policy revision is stale. The runtime's fallback for a failed
    // GitHub read carries no revision and must replace the last verified state.
    const githubRevision = source?.github.policyRevision
    if (source && snapshot.source && (githubMutationPending || (githubRevision !== undefined && githubRevision < (snapshot.source.github.policyRevision ?? 0)))) source = { ...source, github: snapshot.source.github }
    if (source && activeConfiguration) source = { ...source, sandboxConfigurationOperation: activeConfiguration }
    publish({ ...snapshot, source, backup, loading: configurationUpdating && !source, error })
    void refreshNetwork()
    // One remote read per refresh; one that started during this refresh is recent enough.
    if (remotePasses === remotePassesAtStart) void refreshComputers()
  }

  async function onWindowFocus() {
    await refresh()
    if (disposed || !refreshRepositoriesOnReturn) return
    refreshRepositoriesOnReturn = false
    if (snapshot.source?.github.state === "connected") {
      await githubMutation("refresh_github_repositories").catch(() => {})
    }
  }

  async function initialize() {
    try {
      unlisten.push(await native.listen("silo://network-state-changed", () => { void refreshNetwork() }))
      unlisten.push(await native.listen("silo://operation-queue-changed", () => { void refreshOperationQueue() }))
      unlisten.push(await native.listen("silo://application-state-changed", refreshFromEvent))
      unlisten.push(await native.listen("desktop:status-opened", refreshFromEvent))
      // A cancelled Quit (VMs would not stop, settings failed to save) keeps Silo open,
      // so setup and sandbox configuration must be accepted again.
      unlisten.push(await native.listen("silo://shutdown-state-changed", (event) => { if (event?.payload === false) acceptingSetup = true }))
      unlisten.push(await native.listen("silo://machine-configuration-progress", (event) => {
        const parsed = siloProgressEventSchema.safeParse(event?.payload)
        if (!parsed.success || parsed.data.requestId !== activeRequestId || !activeConfiguration) return
        const progressEvents = [...activeConfiguration.progressEvents, parsed.data]
        activeConfiguration = { ...activeConfiguration, progressEvents }
        publish({ ...snapshot, setupEvents: progressEvents, setupActivity: progressEvents, source: snapshot.source ? { ...snapshot.source, sandboxConfigurationOperation: activeConfiguration } : null })
        if (parsed.data.step === "workspace-verification" && activeMachineJob) setJobStatus(activeMachineJob, ["workspaceVerify"], "running")
      }))
    } catch (cause) {
      unlisten.splice(0).forEach((stop) => stop())
      const error = `Silo could not subscribe to application updates: ${errorMessage(cause)}`
      publish({ ...snapshot, loading: false, error })
      throw new Error(error)
    }
    window.addEventListener("focus", onWindowFocus)
    document.addEventListener("visibilitychange", onVisibilityChange)
    // Polling starts before the first loads finish, so a slow computer cannot hold it back.
    remoteTimer = setInterval(() => {
      // Repository changes inside a VM do not emit application events. A hidden
      // window (the closed main window, the unopened status panel) does no polling,
      // including remote SSH snapshots; slow reads finish before another poll, and
      // each refresh reads remote computers once when it completes.
      if (document.visibilityState === "hidden" || activeRefreshes > 0) return
      void refresh()
    }, 10_000)
    await Promise.all([refresh(), readSetupActivity(), refreshComputers(), refreshOperationQueue()])
  }

  function onVisibilityChange() {
    if (document.visibilityState !== "hidden" && activeRefreshes === 0) void refresh()
  }

  // Native state events arrive in bursts. Run at most one refresh at a time and
  // one trailing refresh for everything that arrived while it was running.
  let eventRefresh: Promise<void> | undefined
  let eventRefreshAgain = false
  function refreshFromEvent() {
    if (eventRefresh) { eventRefreshAgain = true; return }
    eventRefresh = (async () => {
      do { eventRefreshAgain = false; await refresh() } while (eventRefreshAgain && !disposed)
    })().finally(() => { eventRefresh = undefined })
  }

  // Remote VM ports are opened through the remote bridge; the local command
  // never handles `silo-remote:` targets.
  function openNetworkPort(workspace: string, port: number) {
    const remote = parseRemoteWorkspaceTarget(workspace)
    return native.invoke<void>(remote ? "remote_open_network_port" : "open_network_port", remote ? { ...remote, port } : { workspace, port })
  }

  // Once the application has loaded, `snapshot.error` is no longer rendered, so an
  // action failure becomes a keyed failure notice (a repeat replaces the earlier one,
  // and it is mirrored to the system while Silo is in the background).
  function reportActionFailure(key: string, title: string, message: string) {
    if (!snapshot.source) { publish({ ...snapshot, error: message }); return }
    showOperationFailure(key, title, { description: message })
  }

  function reportUnavailable(message: string) {
    void native.invoke("show_integration_error", { message }).catch((cause) => {
      console.error("Silo request failure:", message, errorMessage(cause))
    })
  }

  function setWorkspaceFailure(action: string, name: string, cause: unknown) {
    const workspace = view.source?.workspaces.find(workspace => workspaceTarget(workspace) === name)
    if (!workspace) return
    const message = errorMessage(cause)
    // A user-requested cancellation is not a failure: record it as a neutral,
    // retryable state so the row shows "<Action> cancelled", not a red error.
    const cancelled = isCancelledError(message)
    const label = `${action[0].toUpperCase()}${action.slice(1)}`
    workspaceFailures.set(name, { machineId: workspace.machine.id, action, message: cancelled ? message : `${label} failed: ${message}`, cancelled })
    publish({ ...snapshot, source: snapshot.source ? { ...snapshot.source,
      workspaces: snapshot.source.workspaces.map(item => workspaceTarget(item) === name ? { ...item, freshness: "stale" } : item),
    } : null })
  }

  /** The sandbox's display name for system notifications; the target encodes the host and id. */
  function remoteDisplayName(target: string): string | null {
    return view.source?.workspaces.find(item => workspaceTarget(item) === target)?.machine.name ?? null
  }

  function workspaceAction(action: string, name: string, extras: Record<string, unknown> = {}) {
    const remote = parseRemoteWorkspaceTarget(name)
    if (remote && !remoteComputers.find(computer => computer.id === remote.hostId)?.connected) {
      reportUnavailable("This computer is unavailable. Reconnect before changing its VMs.")
      return
    }
    const key = `${action}:${name}`
    if (pendingWorkspaceActions.has(key) || pendingLifecycle.has(name)) return
    pendingWorkspaceActions.add(key)
    const lifecycle = action === "start" || action === "stop" || action === "restart" || action === "dismiss-error"
    // Submitting a lifecycle action supersedes any prior failure or cancellation for
    // this VM: the view hides it while the resubmitted action waits or runs.
    if (lifecycle) {
      workspaceFailures.delete(name)
      pendingLifecycle.set(name, action)
      publish({ ...snapshot })
    }
    void native.invoke<unknown>(remote && lifecycle ? "remote_workspace_action" : "workspace_action", remote && lifecycle ? { ...remote, action, name: remoteDisplayName(name), ...extras } : { action, name, ...extras })
      // The follow-up refresh is not awaited: the action is finished, so a repeat must
      // not be ignored while a slow remote snapshot settles.
      .then((result) => {
        if (remote && !lifecycle) { void refreshComputers(); return }
        const source = parseMutationSource(result, remote ? remoteSnapshots.get(remote.hostId) ?? null : snapshot.source)
        if (lifecycle || workspaceFailures.get(name)?.action === action) workspaceFailures.delete(name)
        if (lifecycle && pendingLifecycle.get(name) === action) pendingLifecycle.delete(name)
        if (remote) {
          bumpRemote(remote.hostId)
          remoteSnapshots.set(remote.hostId, source)
          publish({ ...snapshot, error: null })
          void refreshComputers()
          return
        }
        ++refreshSequence
        publish({ ...snapshot, source, error: null })
        void refresh()
      })
      .catch((cause) => {
        if (!remote) { setWorkspaceFailure(action, name, cause); return }
        // One VM's failure (e.g. insufficient memory) belongs on that VM's row. Whether
        // the computer itself is reachable is decided by the next transport check.
        if (lifecycle) { setWorkspaceFailure(action, name, cause); void refreshComputers(); return }
        reportActionFailure(key, `Could not ${action.replace(/-/g, " ")}`, errorMessage(cause))
      })
      .finally(() => {
        pendingWorkspaceActions.delete(key)
        if (lifecycle && pendingLifecycle.get(name) === action) pendingLifecycle.delete(name)
        publish({ ...snapshot })
      })
  }

  function projectSetupJobs() {
    publish({ ...snapshot, setupQueue: snapshot.setupQueue.map((item) => {
      const states = setupJobs.flatMap((job) => job.items.filter(({ id }) => id === item.id))
      return states.find(({ status }) => status === "running") ?? states.find(({ status }) => status === "queued") ?? states.at(-1) ?? item
    }) })
  }

  function setSetupStatus(ids: SetupQueueItemID[], status: SetupItem["status"], failure?: string) {
    setupJobs = setupJobs.filter((job) => !job.items.some(({ id }) => ids.includes(id)) || job.items.some(({ status }) => status === "running" || status === "queued"))
    publish({ ...snapshot, setupQueue: snapshot.setupQueue.map((item) => ids.includes(item.id) ? { id: item.id, status, ...(failure && { failure }) } : item) })
    projectSetupJobs()
  }

  function setJobStatus(job: SetupJob, ids: SetupQueueItemID[], status: SetupItem["status"], failure?: string) {
    job.items = job.items.map((item) => ids.includes(item.id) ? { id: item.id, status, ...(failure && { failure }) } : item)
    projectSetupJobs()
  }

  function recordGitHubActivity(requestId: string, phase: "github" | "identity", message: string, failed = false) {
    const event: SiloProgressEvent = { schemaVersion: 1, type: "progress", requestId, phase, step: `${phase}-setup`, timestamp: Date.now(), level: failed ? "error" : "info", message, safeForDisplay: true }
    publish({ ...snapshot, setupActivity: [...(snapshot.setupActivity ?? []), event].slice(-500) })
  }

  function enqueueSetup<T>(ids: SetupQueueItemID[], work: (job: SetupJob) => Promise<T>, activityId = crypto.randomUUID()): Promise<T> {
    setSetupStatus(ids, "queued")
    const activityPhase = ids.includes("githubRun") ? "github" : ids.includes("identityRun") ? "identity" : null
    const activityLabel = activityPhase === "github" ? "GitHub access" : "Git identity"
    const job: SetupJob = { activityId, items: ids.map((id) => ({ id, status: "queued" })) }
    setupJobs.push(job)
    projectSetupJobs()
    const promise = setupTail.then(async () => {
      if (disposed) throw new Error("Silo was closed before the setup task started.")
      setJobStatus(job, [ids[0]], "running")
      if (activityPhase) recordGitHubActivity(activityId, activityPhase, `${activityLabel}: applying settings.`)
      try {
        const result = await work(job)
        setJobStatus(job, ids, "succeeded")
        if (activityPhase) recordGitHubActivity(activityId, activityPhase, `${activityLabel}: setup complete.`)
        return result
      } catch (cause) {
        setJobStatus(job, ids, "failed", errorMessage(cause))
        if (activityPhase) recordGitHubActivity(activityId, activityPhase, `${activityLabel}: setup failed. Review the reported error before retrying.`, true)
        throw cause
      }
    })
    setupTail = promise.catch(() => {})
    return promise
  }

  // The committed local VM inventory the user is editing from. Targeted changes carry
  // this as their `expected` baseline so a queued edit applies to fresh state.
  function committedMachines(): SetupMachineConfiguration[] {
    return (snapshot.source?.workspaces ?? [])
      .filter((workspace) => !workspace.computer)
      .map((workspace) => setupMachineConfigurationSchema.parse(workspace.machine))
  }

  // What to apply: a set of targeted changes, or a resume of a failed attempt. An empty
  // change list is a no-op that never reaches the backend.
  type ConfigureAction =
    | { kind: "changes"; changes: MachineConfigurationChange[] }
    | { kind: "retry"; workspace?: string }

  function configureMachines(request: SetupMachineConfigurationRequest, action?: ConfigureAction): Promise<ApplicationSource> {
    if (!acceptingSetup) return Promise.reject(new Error("Silo is quitting. Setup was not submitted."))
    const resolved: ConfigureAction = action ?? { kind: "changes", changes: deriveMachineChanges(committedMachines(), request.machines) }
    // A no-op submission changes nothing; resolve with the current source untouched.
    if (resolved.kind === "changes" && resolved.changes.length === 0) return Promise.resolve(snapshot.source as ApplicationSource)
    const key = JSON.stringify([request, resolved])
    if (lastMachineJob?.key === key) return lastMachineJob.promise
    ++identityVerificationSequence
    lastVerificationKey = undefined
    lastIdentityJob = undefined
    lastGitHubJob = undefined
    setSetupStatus(["identityRun", "identityVerify", "githubRun", "githubVerify", "completion"], "idle")
    const promise = enqueueSetup(["workspaceRun", "workspaceVerify"], async (job) => {
      activeMachineJob = job
      setSetupStatus(["identityRun", "identityVerify", "githubRun", "githubVerify", "completion"], "idle")
      ++operationSequence
      const requestId = crypto.randomUUID()
      activeRequestId = requestId
      activeConfiguration = { id: requestId, status: "applying", candidate: request, progressEvents: [], result: null, error: null }
      publish({ ...snapshot, setupCandidate: request, setupEvents: [], setupActivity: [], setupStartedAt: Math.floor(Date.now() / 1000), setupFinishedAt: undefined, source: snapshot.source ? { ...snapshot.source, sandboxConfigurationOperation: activeConfiguration } : null })
      let failed = false
      let stale = false
      try {
        const result = parseMutationSource(await (resolved.kind === "retry"
          ? native.invoke("retry_machine_configuration", { requestId, ...(resolved.workspace ? { retryWorkspace: resolved.workspace } : {}) })
          : native.invoke("change_machine_configuration", { change: resolved.changes.length === 1 ? resolved.changes[0] : { kind: "batch", changes: resolved.changes }, requestId })))
        activeConfiguration = null
        ++refreshSequence
        publish({ ...snapshot, source: result, error: null })
        return result
      } catch (cause) {
        failed = true
        // A stale-baseline rejection is not a setup failure: the edit never applied
        // because the VM changed underneath it. Surface it inline in the editor that
        // raised it (which keeps the user's edits) instead of the configuration-failed
        // banner, and let the caller reject so that editor can react.
        stale = isStaleConfigurationError(cause)
        if (stale) {
          activeConfiguration = null
          if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, sandboxConfigurationOperation: null } })
        } else {
          activeConfiguration = { ...activeConfiguration!, status: "failed", error: { code: "native_bridge_failed", message: errorMessage(cause), recovery: "Review the configuration and retry.", workspace: snapshot.setupEvents.at(-1)?.workspace ?? null, retryable: true } }
          if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, sandboxConfigurationOperation: activeConfiguration } })
        }
        throw cause
      } finally {
        await readSetupActivity(requestId)
        await refresh()
        if (failed && !stale && !snapshot.setupActivity?.some((event) => event.requestId === requestId && (event.step === "setup-failed" || event.step === "setup-interrupted"))) {
          const event: SiloProgressEvent = { schemaVersion: 1, type: "progress", requestId, phase: "workspaces", step: "setup-failed", timestamp: Date.now(), level: "error", message: "Silo could not finish sandbox setup. Review the reported error and retry. This failure could not be retained in activity history.", safeForDisplay: true }
          publish({ ...snapshot, setupActivity: [...(snapshot.setupActivity ?? []), event] })
        }
        activeRequestId = null
        activeMachineJob = undefined
        publish({ ...snapshot, setupFinishedAt: Math.floor(Date.now() / 1000) })
      }
    })
    // Only an in-flight job is shared: a later identical request (Continue on a
    // starting VM, Retry after a failure) must reach the backend again.
    lastMachineJob = { key, promise }
    const settled = () => { if (lastMachineJob?.promise === promise) lastMachineJob = undefined }
    void promise.then(settled, settled)
    return promise
  }

  async function verifySetupIdentities(request: Pick<OnboardingCompletionRequest, "machineConfiguration" | "github">): Promise<void> {
    const key = JSON.stringify([request.machineConfiguration, request.github.workspaces.map(({ workspace, identity }) => ({ workspace, identity }))])
    if (key === lastVerificationKey) return
    const sequence = ++identityVerificationSequence
    if (snapshot.setupQueue.some(({ status }) => status === "queued" || status === "running")) {
      await setupTail
      if (disposed || sequence !== identityVerificationSequence) return
      return verifySetupIdentities(request)
    }
    lastVerificationKey = key
    lastIdentityJob = undefined
    setSetupStatus(["identityRun", "identityVerify"], "idle")
    const identities = request.github.workspaces.map(({ workspace, identity }) => ({ workspace, ...identity }))
    const machines = request.machineConfiguration.machines
    if (identities.length !== machines.length || machines.some(({ name }) => !identities.some(({ workspace }) => workspace === name))) return
    try {
      const verified = z.boolean().parse(await native.invoke("verify_workspace_identities", { identities }))
      if (disposed || sequence !== identityVerificationSequence) return
      setSetupStatus(["identityRun", "identityVerify"], verified ? "succeeded" : "idle")
    } catch {
      // A read failure cannot establish completion. Continue will run the normal
      // setup operation and report any actionable runtime error there.
      if (!disposed && sequence === identityVerificationSequence) setSetupStatus(["identityRun", "identityVerify"], "idle")
    }
  }

  function submitSetupStep(step: "workspaces" | "github", request: OnboardingCompletionRequest): Promise<unknown> {
    if (!acceptingSetup) return Promise.reject(new Error("Silo is quitting. Setup was not submitted."))
    ++identityVerificationSequence
    const current = snapshot.source
    const machinesUnchanged = current && current.workspaces.length > 0
      && !current.sandboxConfigurationOperation && !activeConfiguration
      && !setupJobs.some((job) => job.items.some(({ status }) => status === "running" || status === "queued"))
      && current.workspaces.every(({ freshness, state }) => freshness === "fresh" && state !== "failed" && state !== "starting")
      && JSON.stringify(current.workspaces.map(({ machine }) => setupMachineConfigurationSchema.parse(machine))) === JSON.stringify(request.machineConfiguration.machines.map((machine) => setupMachineConfigurationSchema.parse(machine)))
    // Initial setup and continues send the specific creations/edits as one batch. When
    // the configuration already matches what was committed but an earlier attempt did
    // not complete, resume that attempt instead of sending an empty change set.
    const changes = machinesUnchanged ? [] : deriveMachineChanges(committedMachines(), request.machineConfiguration.machines)
    const replaced = replacesEveryMachine(request)
    if (replaced) return Promise.reject(replaced)
    const machineJob = machinesUnchanged
      ? Promise.resolve(current)
      : configureMachines(request.machineConfiguration, changes.length > 0 ? { kind: "changes", changes } : { kind: "retry" })
    if (step === "workspaces") return machineJob
    const activityId = crypto.randomUUID()
    const identities = request.github.workspaces.map(({ workspace, identity }) => ({ workspace, ...identity }))
    const identityKey = JSON.stringify([request.machineConfiguration, identities])
    if (lastIdentityJob?.key !== identityKey) {
      const promise = enqueueSetup(["identityRun", "identityVerify"], async () => {
        await machineJob
        await native.invoke("configure_workspace_identities", { identities })
        lastVerificationKey = JSON.stringify([request.machineConfiguration, request.github.workspaces.map(({ workspace, identity }) => ({ workspace, identity }))])
      }, activityId)
      lastIdentityJob = { key: identityKey, promise }
      void promise.catch(() => { if (lastIdentityJob?.promise === promise) lastIdentityJob = undefined })
    }
    const identityJob = lastIdentityJob.promise
    const key = JSON.stringify([request.machineConfiguration, request.github])
    if (lastGitHubJob?.key === key) return lastGitHubJob.promise
    const promise = enqueueSetup(["githubRun", "githubVerify"], async (job) => {
      await identityJob
      if (request.github.connectionState === "connected") {
        const previous = snapshot.source?.github
        // Connecting enables access; setup must not undo an explicit Disable access.
        let github = await githubMutation("save_github_configuration", { configuration: { accessEnabled: snapshot.source?.github.accessEnabled ?? true, hostIdentity: snapshot.source?.github.hostIdentity ?? null, workspaces: request.github.workspaces.map((policy) => ({ repositoryMode: "selected", allRepositoriesAllowChanges: false, ...policy })) } })
        if (previous?.policyRevision === github.policyRevision && previous?.workspaceOperations?.some(({ status }) => status === "failed") && github.workspaceOperations?.some(({ status }) => status === "failed")) github = await githubMutation("retry_github_configuration")
        setJobStatus(job, ["githubRun"], "succeeded")
        setJobStatus(job, ["githubVerify"], "running")
        recordGitHubActivity(job.activityId, "github", "GitHub settings saved. Waiting for each sandbox to confirm access.")
        await waitForGitHubAccess(github, request.github.workspaces.map(({ workspace }) => workspace))
      }
    }, activityId)
    lastGitHubJob = { key, promise }
    void promise.catch(() => { if (lastGitHubJob?.promise === promise) lastGitHubJob = undefined })
    return promise
  }

  // Onboarding can mount before the real configuration loads and seed its draft
  // from defaults. A draft that keeps none of the existing VMs is therefore never
  // treated as a request to delete them all; single removals remain explicit edits.
  function replacesEveryMachine(request: OnboardingCompletionRequest) {
    const committed = committedMachines()
    if (committed.length === 0) return null
    const kept = new Set(request.machineConfiguration.machines.map(({ id }) => id))
    if (committed.some(({ id }) => kept.has(id))) return null
    return new Error(`Setup does not delete existing VMs (${committed.map(({ name }) => name).join(", ")}). Reopen Silo to load them, or delete them from Silo after setup. No VM changed.`)
  }

  function finishSetup(request: OnboardingCompletionRequest, markComplete: () => Promise<void>) {
    if (!acceptingSetup) return Promise.reject(new Error("Silo is quitting. Setup was not submitted."))
    const preceding = submitSetupStep("github", request)
    void preceding.catch(() => {})
    if (replacesEveryMachine(request)) return preceding
    return enqueueSetup(["completion"], async () => { await preceding; await markComplete() })
  }

  async function drainSetup() {
    acceptingSetup = false
    await setupTail
  }

  function saveMachineConfiguration(request: SetupMachineConfigurationRequest, baseline?: SetupMachineConfiguration[]): Promise<void> {
    // Send the specific create/edit/delete/reorder against the baseline the user started
    // editing from — the committed configuration as it was when the editor opened — so a
    // queued edit applies to the latest settings, and is rejected instead of silently
    // overwriting concurrent work, when the VM changed while the edit waited. When no
    // baseline is supplied (e.g. onboarding drafts) the current committed list is used.
    // Several simultaneous changes travel as one atomic batch; a no-op does nothing.
    const changes = deriveMachineChanges(baseline ?? committedMachines(), request.machines)
    if (changes.length === 0) return Promise.resolve()
    return configureMachines(request, { kind: "changes", changes }).then(() => undefined)
  }

  async function waitForGitHubAccess(initial: z.infer<typeof githubStateShape>, workspaces: string[]) {
    let github = initial
    const revision = initial.policyRevision
    const deadline = Date.now() + 300_000
    while (true) {
      if (disposed) throw new Error("Silo closed before GitHub access was verified.")
      if (revision !== undefined && (github.policyRevision !== revision || (snapshot.source?.github.policyRevision ?? revision) > revision)) throw new Error("GitHub settings changed during setup. Continue again to verify the latest settings.")
      const operations = workspaces.map((workspace) => github.workspaceOperations?.find((operation) => operation.workspace === workspace))
      const failure = operations.find((operation) => operation?.status === "failed")
      if (failure) throw new Error(failure.message)
      if (operations.every((operation) => operation?.status === "succeeded")) return
      if (Date.now() >= deadline) throw new Error("GitHub access has not been verified in every sandbox. Retry to check again.")
      await new Promise((resolve) => window.setTimeout(resolve, 500))
      github = githubStateShape.parse(await native.invoke("read_github_state"))
      if (!githubMutationPending && snapshot.source && (github.policyRevision ?? 0) >= (snapshot.source.github.policyRevision ?? 0)) publish({ ...snapshot, source: { ...snapshot.source, github } })
    }
  }

  async function githubMutation(command: string, arguments_?: Record<string, unknown>) {
    const sequence = ++githubMutationSequence
    githubMutationPending = command === "save_github_configuration"
    ++refreshSequence
    const connectionAttempt = command === "connect_github" ? crypto.randomUUID() : null
    if (connectionAttempt) recordGitHubActivity(connectionAttempt, "github", "Opening GitHub authorization in your browser.")
    try {
      const github = githubStateShape.parse(await native.invoke(command, arguments_))
      if (sequence === githubMutationSequence && snapshot.source && (github.policyRevision ?? 0) >= (snapshot.source.github.policyRevision ?? 0)) publish({ ...snapshot, source: { ...snapshot.source, github }, error: null })
      if (connectionAttempt && sequence === githubMutationSequence) recordGitHubActivity(connectionAttempt, "github", github.state === "connected" ? "GitHub account connected." : "GitHub authorization is pending.")
      return github
    } catch (cause) {
      if (connectionAttempt && sequence === githubMutationSequence) recordGitHubActivity(connectionAttempt, "github", "GitHub connection did not complete. You can try connecting again.", true)
      if (command === "connect_github" && sequence === githubMutationSequence) {
        try {
          const github = githubStateShape.parse(await native.invoke("read_github_state"))
          if (sequence === githubMutationSequence && snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, github } })
        } catch { /* Keep the last verified state if reading also fails. */ }
      }
      const message = `GitHub operation failed: ${errorMessage(cause)}`
      if (sequence === githubMutationSequence && snapshot.source) publish({ ...snapshot, error: message, source: { ...snapshot.source, github: { ...snapshot.source.github,
        ...(!(["save_github_configuration", "save_github_personal_token", "remove_github_personal_token"].includes(command)) && { repositoryCatalogStatus: { status: "unavailable" as const, message, canRetry: command === "refresh_github_repositories" } }),
      } } })
      throw cause
    } finally {
      if (sequence === githubMutationSequence) githubMutationPending = false
    }
  }

  async function checkpointAction(command: string, target: string, arguments_: Record<string, unknown>) {
    const remote = parseRemoteWorkspaceTarget(target)
    const localWorkspace = remote ? undefined : snapshot.source?.workspaces.find(item => !item.computer && item.machine.kind === "vm" && (item.machine.name === target || item.machine.id === target))
    if (!remote && !localWorkspace) throw new Error("This sandbox is unavailable. Refresh and try again.")
    const checkpointTarget = remote ? remoteWorkspaceTarget(remote.hostId, remote.vmId) : workspaceTarget(localWorkspace!)
    const ownerWorkspace = remote
      ? remoteSnapshots.get(remote.hostId)?.workspaces.find(item => item.machine.kind === "vm" && item.machine.id === remote.vmId)
      : localWorkspace
    if (pendingCheckpointOperations.has(checkpointTarget) || ownerWorkspace?.checkpointOperation?.status === "running") {
      throw new Error("A checkpoint operation is already running for this sandbox.")
    }
    const kind: WorkspaceCheckpointOperation["kind"] = command === "create_checkpoint" ? "capture" : command === "fork_checkpoint" ? "fork" : command === "restore_checkpoint" ? "restore" : (() => { throw new Error("Unsupported checkpoint operation.") })()
    const operation: WorkspaceCheckpointOperation = {
      kind,
      status: "running",
      stage: kind === "capture" ? "Creating checkpoint…" : kind === "fork" ? "Creating stopped fork…" : "Saving recovery checkpoint and restoring…",
    }
    pendingCheckpointOperations.set(checkpointTarget, operation)
    publish({ ...snapshot })
    if (remote) {
      const action = kind === "capture" ? "create" : kind
      try {
        await native.invoke("remote_checkpoint_action", { hostId: remote.hostId, vmId: remote.vmId, action, ...arguments_ })
        bumpRemote(remote.hostId)
        await refreshComputers(true)
      } catch (cause) {
        bumpRemote(remote.hostId)
        void refreshComputers()
        throw cause
      } finally {
        pendingCheckpointOperations.delete(checkpointTarget)
        publish({ ...snapshot })
      }
      return
    }
    try {
      const result = await native.invoke<unknown>(command, { workspaceId: localWorkspace!.machine.id, ...arguments_ })
      ++refreshSequence
      publish({ ...snapshot, source: parseMutationSource(result), error: null })
      void refresh()
    } catch (cause) {
      void refresh()
      throw cause
    } finally {
      pendingCheckpointOperations.delete(checkpointTarget)
      publish({ ...snapshot })
    }
  }

  const applicationActions: ApplicationActions = {
    createCheckpoint: (workspace, name) => checkpointAction("create_checkpoint", workspace, { name }),
    forkCheckpoint: (workspace, checkpointId, newName) => checkpointAction("fork_checkpoint", workspace, { checkpointId, newName }),
    restoreCheckpoint: (workspace, checkpointId) => checkpointAction("restore_checkpoint", workspace, { checkpointId }),
    refreshRepositories: async () => {
      await Promise.all([refresh(true), refreshComputers(true)])
      if (snapshot.error) throw new Error(snapshot.error)
    },
    queryLogs: async request => logPageSchema.parse(await native.invoke("query_sandbox_logs", { request })),
    exportLogs: async requests => z.boolean().parse(await native.invoke("export_workspace_logs", { requests })),
    cancelLogExport: async () => { await native.invoke("cancel_log_export") },
    setRemoteManagement: async enabled => {
      remoteManagement = remoteManagementSchema.parse(await native.invoke("set_remote_management", { enabled }))
      remoteManagementError = undefined
      publish({ ...snapshot })
    },
    connectComputer: async address => {
      remoteComputerSchema.parse(await native.invoke("connect_remote_host", { address }))
      // A list read that started before the connection is read again, so the new
      // computer is listed when this resolves.
      remoteListRevision++
      await refreshComputers()
    },
    removeComputer: async hostId => {
      await native.invoke("remove_remote_host", { hostId })
      remoteListRevision++
      bumpRemote(hostId)
      remoteHosts = remoteHosts.filter(host => host.id !== hostId)
      remoteComputers = remoteComputers.filter(computer => computer.id !== hostId)
      remoteSnapshots.delete(hostId)
      slowComputers.delete(hostId)
      publish({ ...snapshot })
    },
    saveRemoteMachine: async (hostId, machine, expected) => {
      const target = parseRemoteWorkspaceTarget(machine.id)
      const source = parseMutationSource(await native.invoke("remote_upsert_machine", {
        hostId, machine: { ...machine, id: target?.vmId ?? machine.id },
        expected: expected ? { ...expected, id: parseRemoteWorkspaceTarget(expected.id)?.vmId ?? expected.id } : null,
      }), remoteSnapshots.get(hostId) ?? null)
      bumpRemote(hostId)
      remoteSnapshots.set(hostId, source)
      publish({ ...snapshot })
      void refreshComputers()
    },
    deleteRemoteMachine: async (hostId, machine) => {
      const vmId = parseRemoteWorkspaceTarget(machine.id)?.vmId
      if (!vmId) throw new Error("The remote VM identity is missing.")
      const source = parseMutationSource(await native.invoke("remote_delete_machine", { hostId, vmId, expected: { ...machine, id: vmId } }), remoteSnapshots.get(hostId) ?? null)
      bumpRemote(hostId)
      remoteSnapshots.set(hostId, source)
      publish({ ...snapshot })
      void refreshComputers()
    },
    saveSecret: (request: SecretConfigurationRequest) => changeSecret("save_secret", { request }),
    removeSecret: (id: string) => changeSecret("remove_secret", { id }),
    retrySecret: (id: string) => changeSecret("retry_secret", { id }),
    readWorkspaceStorage: async workspaceId => workspaceStorageStateSchema.parse(await native.invoke("read_workspace_storage", { workspaceId })),
    reclaimWorkspaceStorage: async workspaceId => workspaceStorageStateSchema.parse(await native.invoke("reclaim_workspace_storage", { workspaceId })),
    refreshSshAccess,
    sshConnection: (workspace, download, network) => {
      const remote = parseRemoteWorkspaceTarget(workspace)
      return native.invoke<string | null>("ssh_connection", remote ? { ...remote, download, ...(network === undefined ? {} : { network }) } : { workspace, download, ...(network === undefined ? {} : { network }) })
    },
    saveSshAccess: async request => {
      const remote = parseRemoteWorkspaceTarget(request.workspace)
      const owner = remote?.hostId ?? ""
      if (sshAccess?.workspaces.find(row => row.workspace === request.workspace)?.unavailable || (remote && !remoteComputers.find(computer => computer.id === remote.hostId)?.connected)) throw new Error("Refresh SSH status before changing access.")
      const revision = ++sshRevision
      sshSaveRevisions.set(owner, revision)
      const { workspace: _workspace, ...settings } = request
      const result = sshAccessShape.parse(await native.invoke(remote ? "remote_save_ssh_access" : "save_ssh_access", remote ? { ...remote, ...settings } : { ...request }))
      if (result.workspaces.some(row => sshOwner(row.workspace) !== owner)) throw new Error("SSH response belongs to another computer.")
      if (disposed || sshSaveRevisions.get(owner) !== revision) return
      if (remote && !remoteComputers.find(computer => computer.id === remote.hostId)?.connected) return
      ++sshRevision
      const retained = sshAccess?.workspaces.filter(row => sshOwner(row.workspace) !== owner) ?? []
      sshAccess = { workspaces: [...retained, ...result.workspaces] }
      if (!remote) sshAccessError = null
      publish({ ...snapshot })
    },
    refreshNetwork,
    saveNetworkPort: request => changeNetwork("save_network_port", { ...request }),
    removeNetworkPort: (workspace, port) => changeNetwork("remove_network_port", { workspace, port }),
    openNetworkPort,
    authorizeComputer: address => native.invoke<void>("remote_authorize_ssh", { address }),
    setupComputerKey: address => native.invoke<void>("remote_setup_ssh_key", { address }),
    listWorkspaceDirectory: async (workspace, path, offset, snapshotId) => directoryPageShape.parse(await native.invoke("list_workspace_directory", { workspace, path, offset, snapshotId: snapshotId ?? null })),
    retryRuntimeChecks: () => { void refresh() },
    saveMachineConfiguration,
    dismissMachineConfigurationError: () => {
      if (activeConfiguration?.status !== "failed") return
      activeConfiguration = null
      publish({ ...snapshot, setupCandidate: undefined, source: snapshot.source ? { ...snapshot.source, sandboxConfigurationOperation: null } : null })
    },
    retryMachineConfiguration: (workspace) => {
      const operation = snapshot.source?.sandboxConfigurationOperation
      if (operation) void configureMachines(operation.candidate, { kind: "retry", workspace }).catch(() => {})
    },
    dismissRepositoryPush: (workspace, repositoryPath) => statusActions.dismissRepositoryPush(workspace, repositoryPath),
    pushRepository: (workspace, repositoryPath) => {
      const key = pushKey(workspace, repositoryPath)
      if (pendingRepositoryPushes.has(key) || view.source?.repositoryPushOperations.some(operation => operation.workspace === workspace && operation.repositoryPath === repositoryPath && (operation.status === "pushing" || operation.status === "unknown"))) return
      const commitCount = view.source?.workspaces.find(item => workspaceTarget(item) === workspace)?.repositories.find(repository => repository.path === repositoryPath)?.ahead ?? 0
      // Polling stops once this push is finished or its sandbox (or computer) is gone.
      const owner = {}
      const current = () => !disposed && activePushes.get(key) === owner
      activePushes.set(key, owner)
      unconfirmedPushes.delete(key)
      pendingRepositoryPushes.set(key, { workspace, repositoryPath, commitCount, status: "pushing" })
      publish({ ...snapshot })
      // Push results are shown on the repository row, never through `snapshot.error`,
      // which is not rendered once the application has loaded.
      const finish = (operation: ApplicationSource["repositoryPushOperations"][number]) => {
        pendingRepositoryPushes.delete(key)
        activePushes.delete(key)
        ++refreshSequence
        const remote = parseRemoteWorkspaceTarget(workspace)
        if (remote) bumpRemote(remote.hostId)
        const host = remote && remoteSnapshots.get(remote.hostId)
        if (remote && host) {
          const name = host.workspaces.find(workspace => workspace.machine.id === remote.vmId)?.machine.name
          if (name) remoteSnapshots.set(remote.hostId, { ...host, repositoryPushOperations: [
            ...host.repositoryPushOperations.filter(operation => operation.workspace !== name || operation.repositoryPath !== repositoryPath),
            { ...operation, workspace: name },
          ] })
        }
        if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source,
          repositoryPushOperations: [...snapshot.source.repositoryPushOperations.filter(operation => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath), { ...operation, workspace }],
        } })
      }
      let operationId: string = crypto.randomUUID()
      const terminalShape = z.discriminatedUnion("status", [
        z.object({ operationId: z.string().optional(), status: z.literal("succeeded"), commitCount: z.number() }),
        z.object({ operationId: z.string().optional(), status: z.literal("unknown"), commitCount: z.number(), message: z.string() }),
        z.object({ operationId: z.string().optional(), status: z.literal("failed"), commitCount: z.number(), message: z.string(), diagnosticDetails: z.string().optional() }),
      ])
      // Unanswered status checks back off exponentially; after PUSH_STATUS_ATTEMPTS in a
      // row the push ends as a dismissible "unknown" result instead of spinning forever.
      let failures = 0
      const schedule = () => {
        if (!current()) return
        const timer = setTimeout(() => {
          pushPollTimers.delete(timer)
          void observe(false)
        }, Math.min(PUSH_STATUS_INTERVAL_MS * 2 ** failures, PUSH_STATUS_MAX_INTERVAL_MS))
        pushPollTimers.add(timer)
      }
      const observe = async (start: boolean): Promise<void> => {
        if (!current()) return
        try {
          const result = await native.invoke(start ? "start_repository_push" : "repository_push_status", { workspace, repositoryPath, operationId })
          if (!current()) return
          // No saved job means the first request never arrived. Reuse its identifier.
          if (result === null && !start) return observe(true)
          const parsed = terminalShape.safeParse(result)
          if (parsed.success) {
            const { operationId: _id, ...operation } = parsed.data
            finish({ ...operation, workspace, repositoryPath })
            if (operation.status === "succeeded") void refresh()
            return
          }
          const active = z.object({ operationId: z.string(), status: z.literal("pushing") }).parse(result)
          operationId = active.operationId
          failures = 0
          pendingRepositoryPushes.set(key, { workspace, repositoryPath, commitCount, status: "pushing" })
          publish({ ...snapshot })
        } catch (cause) {
          if (!current()) return
          // A lost connection is not a failed push. Keep the button disabled and
          // query the host-owned operation until it supplies an actual result.
          if (++failures >= PUSH_STATUS_ATTEMPTS) {
            pendingRepositoryPushes.delete(key)
            activePushes.delete(key)
            unconfirmedPushes.set(key, { operationId, workspace, repositoryPath, commitCount, status: "unknown", message: `Silo could not confirm this push (${errorMessage(cause)}). Check the branch on GitHub before pushing again.` })
            publish({ ...snapshot })
            return
          }
          pendingRepositoryPushes.set(key, { workspace, repositoryPath, commitCount, status: "pushing", message: `Waiting for push status: ${errorMessage(cause)}` })
          publish({ ...snapshot })
        }
        schedule()
      }
      void observe(true)
    },
    startWorkspace: (name) => workspaceAction("start", name),
    stopWorkspace: (name) => workspaceAction("stop", name),
    restartWorkspace: (name) => workspaceAction("restart", name),
    cancelOperation: (id) => {
      void native.invoke("cancel_operation", { id })
        .then(() => refreshOperationQueue())
        .catch((cause) => reportUnavailable(`Silo could not cancel the operation: ${errorMessage(cause)}`))
    },
    dismissWorkspaceError: (name) => workspaceAction("dismiss-error", name),
    openDesktop: async (workspace) => {
      try { await native.invoke("open_desktop", { workspace }) }
      catch (cause) { reportActionFailure(`open-desktop:${workspace}`, "Could not open the desktop", errorMessage(cause)) }
    },
    openTerminal: (name) => workspaceAction("open-terminal", name),
    openEditor: (name, path) => workspaceAction("open-editor", name, path ? { path } : undefined),
    saveGitHubPersonalToken: async token => { await githubMutation("save_github_personal_token", { token }) },
    removeGitHubPersonalToken: async () => { await githubMutation("remove_github_personal_token") },
    connectGitHub: () => { void githubMutation("connect_github").catch(() => {}) },
    cancelGitHubConnection: () => { void githubMutation("cancel_github_connection").catch(() => {}) },
    reopenGitHubAuthorization: () => {
      const sequence = githubMutationSequence
      void native.invoke("reopen_github_authorization").catch((cause: unknown) => {
        if (sequence === githubMutationSequence) reportActionFailure("github-reopen-authorization", "Could not reopen GitHub authorization", errorMessage(cause))
      })
    },
    manageGitHubRepositories: () => {
      refreshRepositoriesOnReturn = true
      void native.invoke("manage_github_repositories").catch((cause: unknown) => {
        refreshRepositoriesOnReturn = false
        reportActionFailure("github-manage-repositories", "Could not open GitHub repository access", errorMessage(cause))
      })
    },
    disconnectGitHub: () => { void githubMutation("disconnect_github").catch(() => {}) },
    setGitHubAccessEnabled: (enabled) => { void githubMutation("set_github_access_enabled", { enabled }).catch(() => {}) },
    saveGitHubConfiguration: async (configuration) => { await githubMutation("save_github_configuration", { configuration }) },
    retryGitHubConfiguration: (workspace) => { void githubMutation("retry_github_configuration", { workspace: workspace ?? null }).catch(() => {}) },
    retryGitHubRepositoryCatalog: () => { void githubMutation("refresh_github_repositories").catch(() => {}) },
  }

  function backupFailure(operation: "backup" | "restore", archive: BackupArchive, message: string, targetName?: string): BackupOperation {
    return { operation, archive, runningNames: [], targetName, kind: "result", outcome: "failed", title: `${operation === "backup" ? "Backup" : "Restore"} failed`, message, detail: "No successful result was recorded." }
  }

  function showPendingBackup(operation: "backup" | "restore", archive: BackupArchive, targetName?: string) {
    ++refreshSequence
    const previous = view.backup.operation
    if (previous?.kind === "result") dismissedBackupResults.add(JSON.stringify(previous))
    requestedOperation = { operation, archive, targetName }
    localBackupOperation = { operation, archive, targetName, runningNames: [], kind: "running", progress: 0, indeterminate: true, canCancel: false,
      phases: [{ title: operation === "backup" ? "Preparing backup" : "Checking backup", detail: operation === "backup" ? "Preparing the selected sandboxes." : "Verifying the archive before restoring it.", tone: "running" }],
    }
    publish({ ...snapshot, backup: { ...snapshot.backup, operation: localBackupOperation } })
  }

  const backupActions: BackupController["actions"] = {
    async chooseDestination() {
      const selected = await native.invoke<string | null>("choose_backup_destination")
      if (selected) await refresh()
      return selected
    },
    async chooseArchive(onSelected) {
      const archivePath = await native.invoke<string | null>("choose_backup_archive")
      if (!archivePath) return null
      onSelected?.(archivePath)
      const inspected = archiveInspectionShape.parse(await native.invoke("inspect_backup_archive", { archivePath }))
      await refresh()
      return inspected
    },
    async inspectArchive(archive) {
      const inspected = archiveInspectionShape.parse(await native.invoke("inspect_backup_archive", { archivePath: archive.archivePath }))
      await refresh()
      return inspected
    },
    startBackup(destination, sandboxes, checkpointId) {
      if (pendingBackupOperation || view.backup.operation?.kind === "running") return
      pendingBackupOperation = true
      showPendingBackup("backup", { name: "Backup", archivePath: "", completedLabel: "Not completed", size: "Unknown", destination, sandboxes })
      void native.invoke("start_backup", { destination, sandboxes, ...(checkpointId && { checkpointId }) }).then(() => { if (localBackupOperation?.kind === "running") dismissedBackupResults.clear(); return refresh() }).catch((cause) => {
        const archive: BackupArchive = { name: "Backup", archivePath: "", completedLabel: "Not completed", size: "Unknown", destination, sandboxes }
        localBackupOperation = backupFailure("backup", archive, errorMessage(cause))
        publish({ ...snapshot, backup: { ...snapshot.backup, operation: localBackupOperation } })
      }).finally(() => { pendingBackupOperation = false })
    },
    startRestore(archive, newName, sourceName) {
      if (pendingBackupOperation || view.backup.operation?.kind === "running") return
      pendingBackupOperation = true
      showPendingBackup("restore", archive, newName)
      void native.invoke("start_restore", { archivePath: archive.archivePath, newName, ...(sourceName && { sourceName }) }).then(() => { if (localBackupOperation?.kind === "running") dismissedBackupResults.clear(); return refresh() }).catch((cause) => {
        localBackupOperation = backupFailure("restore", archive, errorMessage(cause), newName)
        publish({ ...snapshot, backup: { ...snapshot.backup, operation: localBackupOperation } })
      }).finally(() => { pendingBackupOperation = false })
    },
    cancelOperation() { void native.invoke("cancel_backup_operation").then(() => refresh()).catch((cause) => reportUnavailable(`Backup cancellation failed: ${errorMessage(cause)} The operation may still be running.`)) },
    retryStart(name) {
      void native.invoke<unknown>("retry_workspace_start", { name }).then((result) => {
        const source = parseMutationSource(result)
        ++refreshSequence
        publish({ ...snapshot, source, error: null })
        return refresh()
      }).catch((cause) => setWorkspaceFailure("start", name, cause))
    },
    async revealArchive(archive) {
      await native.invoke("reveal_backup_archive", { archivePath: archive.archivePath })
    },
    dismissOperation() {
      const operation = view.backup.operation
      if (operation?.kind !== "result") return
      dismissedBackupResults.add(JSON.stringify(operation))
      localBackupOperation = null
      publish({ ...snapshot, backup: { ...snapshot.backup, operation: null } })
      void native.invoke("dismiss_backup_operation", { expectedOperation: operation, expectedOperationId: snapshot.backup.operationId ?? null })
        .catch(() => console.error("Silo could not save the backup result dismissal. It may appear again after relaunch."))
    },
  }

  const statusActions: StatusBarActions = {
    listWorkspaceDirectory: applicationActions.listWorkspaceDirectory,
    startWorkspace: applicationActions.startWorkspace,
    stopWorkspace: applicationActions.stopWorkspace,
    restartWorkspace: applicationActions.restartWorkspace,
    openTerminal: applicationActions.openTerminal,
    pushRepository: applicationActions.pushRepository,
    openSilo: (route?: StatusBarRoute) => { void native.invoke("open_main", { route: route ?? null }).catch((cause) => console.error("Silo main window:", errorMessage(cause))) },
    quit: () => { void native.invoke("quit_app").catch((cause: unknown) => reportActionFailure("quit", "Could not quit Silo", errorMessage(cause))) },
    refresh: () => { void refresh() },
    openEditor: (name, path) => workspaceAction("open-editor", name, { path }),
    openSite: (workspace, port) => { void Promise.resolve().then(() => openNetworkPort(workspace, port)).catch(() => reportUnavailable("Could not open this service. Check its port in Network.")) },
    dismissRepositoryPush: (workspace, repositoryPath) => {
      // An unconfirmed result exists only here: acknowledging it never waits on its
      // (possibly unreachable) host, which is told on a best-effort basis.
      if (unconfirmedPushes.delete(pushKey(workspace, repositoryPath))) {
        publish({ ...snapshot })
        void native.invoke("dismiss_repository_push", { workspace, repositoryPath }).catch(() => {})
        return
      }
      void native.invoke("dismiss_repository_push", { workspace, repositoryPath }).then(() => {
        ++refreshSequence
        const remote = parseRemoteWorkspaceTarget(workspace)
        if (remote) bumpRemote(remote.hostId)
        const owner = remote && remoteSnapshots.get(remote.hostId)
        if (remote && owner) {
          const name = owner.workspaces.find(workspace => workspace.machine.id === remote.vmId)?.machine.name
          remoteSnapshots.set(remote.hostId, { ...owner, repositoryPushOperations: owner.repositoryPushOperations.filter(operation => operation.workspace !== name || operation.repositoryPath !== repositoryPath || operation.status === "pushing") })
        }
        if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source,
          repositoryPushOperations: snapshot.source.repositoryPushOperations.filter(operation => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath || operation.status === "pushing"),
        } })
        void refresh()
      }).catch(cause => console.error("Silo push dismissal:", errorMessage(cause)))
    },
  }

  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    initialize,
    async loadConfiguration() {
      const configuration = z.object({ schemaVersion: z.literal(1), machines: z.array(setupMachineConfigurationSchema).max(64) }).parse(await native.invoke("read_machine_configuration"))
      publish({ ...snapshot, savedMachines: configuration.machines })
    },
    refresh,
    configureMachines,
    submitSetupStep,
    verifySetupIdentities,
    finishSetup,
    drainSetup,
    applicationActions,
    backupActions,
    statusActions,
    dispose() { pushPollTimers.forEach(clearTimeout); pushPollTimers.clear(); if (remoteTimer) clearInterval(remoteTimer); disposed = true; refreshSequence++; unlisten.forEach((stop) => stop()); window.removeEventListener("focus", onWindowFocus); document.removeEventListener("visibilitychange", onVisibilityChange); listeners.clear() },
  }
}

export type ProductionSource = ReturnType<typeof createProductionSource>

export function useProductionSource(source: ProductionSource) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  return {
    ...snapshot,
    backup: { state: snapshot.backup, actions: source.backupActions } satisfies BackupController,
  }
}
