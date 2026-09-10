import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useSyncExternalStore } from "react"
import { z } from "zod"

import { siloProgressEventSchema, setupMachineConfigurationSchema, type SetupMachineConfiguration, type SiloProgressEvent, type SetupMachineConfigurationRequest, type SetupQueueItemID } from "@/contracts/silo"
import type { OnboardingCompletionRequest, OnboardingSource } from "@/features/onboarding/model/onboarding-source"
import type { NetworkState, ApplicationActions, ApplicationSource, SecretConfigurationRequest } from "@/features/application/model/application-source"
import type { BackupArchive, BackupController, BackupOperation, BackupState } from "@/features/application/model/backup-source"
import type { StatusBarActions, StatusBarRoute } from "@/features/status-bar/status-bar-types"

type EventHandler = (event?: { payload: unknown }) => void

export interface ProductionBridge {
  invoke: <T>(command: string, arguments_?: Record<string, unknown>) => Promise<T>
  listen: (event: string, handler: EventHandler) => Promise<() => void>
}

const bridge: ProductionBridge = {
  invoke: (command, arguments_) => invoke(command, arguments_),
  listen: (event, handler) => listen(event, handler),
}

const githubStateShape = z.object({
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
  state: z.enum(["active", "restart-required"]), pendingWorkspaces: z.array(z.string()).optional(),
  error: z.string().nullish().transform((value) => value ?? undefined), removing: z.boolean().optional(),
})

const applicationSourceShape = z.object({
  runtimeRepair: z.unknown().nullable(),
  workspaces: z.array(z.object({
    machine: z.object({ id: z.string().min(1), kind: z.enum(["vm", "ssh"]), name: z.string().min(1) }).passthrough(),
    purpose: z.string(),
    state: z.enum(["running", "starting", "stopped", "failed"]),
    stateDetail: z.string(),
    freshness: z.enum(["fresh", "stale"]),
    host: z.string(),
    repositories: z.array(z.unknown()), files: z.array(z.unknown()), ports: z.array(z.unknown()), logs: z.array(z.unknown()),
    githubRepositories: z.array(z.string()), secretNames: z.array(z.string()),
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
  snapshotId: z.string(), availability: z.enum(["available", "unavailable"]), availabilityMessage: z.string().optional(),
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

export function createProductionSource(native: ProductionBridge = bridge) {
  let snapshot: ProductionSnapshot = {
    setupQueue: ["workspaceRun", "workspaceVerify", "identityRun", "identityVerify", "githubRun", "githubVerify", "completion"].map((id) => ({ id: id as SetupQueueItemID, status: "idle" })),
    setupEvents: [],
    source: null,
    backup: unavailableBackup("Backup state has not loaded. No sandbox data changed."),
    loading: true,
    error: null,
  }
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
  let network: NetworkState | undefined
  let networkError: string | null = null
  let networkRequest: Promise<void> | undefined
  let networkRevision = 0
  let disposed = false
  let refreshSequence = 0
  let githubMutationSequence = 0
  let githubMutationPending = false
  const unlisten: Array<() => void> = []
  const listeners = new Set<() => void>()
  const pendingWorkspaceActions = new Set<string>()
  const pendingLifecycle = new Map<string, "start" | "stop" | "restart">()
  let pendingBackupOperation = false
  let localBackupOperation: BackupOperation | null = null
  const dismissedBackupResults = new Set<string>()
  let requestedOperation: { operation: "backup" | "restore"; archive: BackupArchive; targetName?: string } | null = null

  function refreshNetwork(): Promise<void> {
    if (networkRequest) return networkRequest
    const revision = networkRevision
    networkRequest = (async () => {
      try {
        const result = networkStateShape.parse(await native.invoke("read_network_state"))
        if (revision !== networkRevision || disposed) return
        network = result; networkError = null
      } catch {
        if (revision !== networkRevision || disposed) return
        networkError = "Could not check network services."
      }
      publish({ ...snapshot })
    })().finally(() => { networkRequest = undefined })
    return networkRequest
  }
  async function changeNetwork(command: string, arguments_: Record<string, unknown>) {
    const revision = ++networkRevision
    const result = networkStateShape.parse(await native.invoke(command, arguments_))
    if (revision !== networkRevision || disposed) return
    network = result; networkError = null
    publish({ ...snapshot })
  }

  async function changeSecret(command: string, arguments_: Record<string, unknown>) {
    const secrets = z.array(secretShape).parse(await native.invoke(command, arguments_))
    if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, secrets } })
    void refresh()
  }

  function publish(next: ProductionSnapshot) {
    if (disposed) return
    let operation = next.backup.operation
    if (operation?.kind === "result" && dismissedBackupResults.has(JSON.stringify(operation))) operation = null
    if (localBackupOperation && operation !== localBackupOperation) {
      if (!operation) operation = localBackupOperation
      else {
        localBackupOperation = null
        if (operation.kind === "running") dismissedBackupResults.clear()
      }
    }
    if (operation?.kind === "result") requestedOperation = null
    next = { ...next, backup: { ...next.backup, operation } }
    if (next.source) next = { ...next, source: { ...next.source, network, networkError,
      workspaces: next.source.workspaces.map(workspace => ({ ...workspace, ports: (network?.workspaces.find(item => item.workspace === workspace.machine.name)?.ports ?? []).map(port => ({ port: port.port, listening: !networkError && !network?.workspaces.find(item => item.workspace === workspace.machine.name)?.error && port.state === "reachable", hostPort: port.hostPort, scheme: port.scheme, configured: port.configured })) }))
    } }
    snapshot = next.source ? { ...next, source: { ...next.source, workspaces: next.source.workspaces.map(({ lifecycleAction: _previous, ...workspace }) => ({ ...workspace, ...(pendingLifecycle.has(workspace.machine.name) && { lifecycleAction: pendingLifecycle.get(workspace.machine.name) }) })) } } : next
    listeners.forEach((listener) => listener())
  }

  function parseMutationSource(value: unknown): ApplicationSource {
    const parsed = parseApplicationSource(value)
    // Mutation responses contain configuration/state but do not load log output.
    // Keep captured lines until the full refresh replaces them with current logs.
    const result = { ...parsed, workspaces: parsed.workspaces.map(workspace => ({
      ...workspace,
      logs: workspace.logs.length ? workspace.logs : snapshot.source?.workspaces.find(previous => previous.machine.id === workspace.machine.id)?.logs ?? [],
    })) }
    return result.github.hostIdentity === undefined
      ? { ...result, github: { ...result.github, hostIdentity: snapshot.source?.github.hostIdentity } }
      : result
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

  async function refresh() {
    const sequence = ++refreshSequence
    const [applicationResult, backupResult] = await Promise.allSettled([
      native.invoke<unknown>("read_application_state"),
      native.invoke<unknown>("read_backup_state"),
    ])
    if (disposed || sequence !== refreshSequence) return
    let source = snapshot.source
    let backup = snapshot.backup
    let error: string | null = null
    if (applicationResult.status === "fulfilled") {
      try { source = parseApplicationSource(applicationResult.value) }
      catch (cause) {
        source = null
        error = `Silo returned invalid application state: ${errorMessage(cause)}`
      }
    } else {
      source = null
      error = `Silo could not read application state: ${errorMessage(applicationResult.reason)}`
    }
    if (backupResult.status === "fulfilled") {
      try {
        backup = parseBackupState(backupResult.value)
      }
      catch (cause) { backup = unreadableBackup(`Silo returned invalid backup state: ${errorMessage(cause)} Refresh to confirm the operation result.`) }
    } else backup = unreadableBackup(`Silo could not read backup state: ${errorMessage(backupResult.reason)} Refresh to confirm the operation result.`)
    if (source && snapshot.source && (githubMutationPending || (source.github.policyRevision ?? 0) < (snapshot.source.github.policyRevision ?? 0))) source = { ...source, github: snapshot.source.github }
    if (source && activeConfiguration) source = { ...source, sandboxConfigurationOperation: activeConfiguration }
    publish({ ...snapshot, source, backup, loading: false, error })
    void refreshNetwork()
  }

  async function initialize() {
    try {
      unlisten.push(await native.listen("silo://network-state-changed", () => { void refreshNetwork() }))
      unlisten.push(await native.listen("silo://application-state-changed", () => { void refresh() }))
      unlisten.push(await native.listen("desktop:status-opened", () => { void refresh() }))
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
    window.addEventListener("focus", refresh)
    await Promise.all([refresh(), readSetupActivity()])
  }

  function reportUnavailable(message: string) {
    void native.invoke("show_integration_error", { message }).catch((cause) => {
      console.error("Silo request failure:", message, errorMessage(cause))
    })
  }

  function setWorkspaceFailure(action: string, name: string, cause: unknown) {
    if (!snapshot.source) return
    const label = `${action[0].toUpperCase()}${action.slice(1)}`
    publish({
      ...snapshot,
      source: { ...snapshot.source, workspaces: snapshot.source.workspaces.map((workspace) => ({ ...workspace, freshness: "stale" })), vmOperationsUnavailable: `${label} failed for ${name}: ${errorMessage(cause)} Refresh to confirm its current state.` },
    })
  }

  function workspaceAction(action: string, name: string, extras: Record<string, unknown> = {}) {
    const key = `${action}:${name}`
    if (pendingWorkspaceActions.has(key) || pendingLifecycle.has(name)) return
    pendingWorkspaceActions.add(key)
    const lifecycle = action === "start" || action === "stop" || action === "restart"
    if (lifecycle) { pendingLifecycle.set(name, action); publish({ ...snapshot }) }
    void native.invoke<unknown>("workspace_action", { action, name, ...extras })
      .then((result) => {
        const source = parseMutationSource(result)
        if (lifecycle && pendingLifecycle.get(name) === action) pendingLifecycle.delete(name)
        publish({ ...snapshot, source, error: null })
        return refresh()
      })
      .catch((cause) => setWorkspaceFailure(action, name, cause))
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

  function configureMachines(request: SetupMachineConfigurationRequest, retryWorkspace?: string): Promise<ApplicationSource> {
    if (!acceptingSetup) return Promise.reject(new Error("Silo is quitting. Setup was not submitted."))
    const key = JSON.stringify([request, retryWorkspace])
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
      try {
        const result = parseMutationSource(await native.invoke("save_machine_configuration", { request, requestId, ...(retryWorkspace ? { retryWorkspace } : {}) }))
        activeConfiguration = null
        publish({ ...snapshot, source: result, error: null })
        return result
      } catch (cause) {
        failed = true
        activeConfiguration = { ...activeConfiguration!, status: "failed", error: { code: "native_bridge_failed", message: errorMessage(cause), recovery: "Review the configuration and retry.", workspace: snapshot.setupEvents.at(-1)?.workspace ?? null, retryable: true } }
        if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, sandboxConfigurationOperation: activeConfiguration } })
        throw cause
      } finally {
        await readSetupActivity(requestId)
        await refresh()
        if (failed && !snapshot.setupActivity?.some((event) => event.requestId === requestId && (event.step === "setup-failed" || event.step === "setup-interrupted"))) {
          const event: SiloProgressEvent = { schemaVersion: 1, type: "progress", requestId, phase: "workspaces", step: "setup-failed", timestamp: Date.now(), level: "error", message: "Silo could not finish sandbox setup. Review the reported error and retry. This failure could not be retained in activity history.", safeForDisplay: true }
          publish({ ...snapshot, setupActivity: [...(snapshot.setupActivity ?? []), event] })
        }
        activeRequestId = null
        activeMachineJob = undefined
        publish({ ...snapshot, setupFinishedAt: Math.floor(Date.now() / 1000) })
      }
    })
    lastMachineJob = { key, promise }
    void promise.catch(() => { if (lastMachineJob?.promise === promise) lastMachineJob = undefined })
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
    if (machines.length === 0 || identities.length !== machines.length || machines.some(({ name }) => !identities.some(({ workspace }) => workspace === name))) return
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
    const machineJob = machinesUnchanged ? Promise.resolve(current) : configureMachines(request.machineConfiguration)
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
        let github = await githubMutation("save_github_configuration", { configuration: { accessEnabled: true, hostIdentity: snapshot.source?.github.hostIdentity ?? null, workspaces: request.github.workspaces.map((policy) => ({ repositoryMode: "selected", allRepositoriesAllowChanges: false, ...policy })) } })
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

  function finishSetup(request: OnboardingCompletionRequest, markComplete: () => Promise<void>) {
    if (!acceptingSetup) return Promise.reject(new Error("Silo is quitting. Setup was not submitted."))
    const preceding = submitSetupStep("github", request)
    void preceding.catch(() => {})
    return enqueueSetup(["completion"], async () => { await preceding; await markComplete() })
  }

  async function drainSetup() {
    acceptingSetup = false
    await setupTail
  }

  function saveMachineConfiguration(request: SetupMachineConfigurationRequest) {
    void configureMachines(request).catch(() => {})
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
      if (connectionAttempt) recordGitHubActivity(connectionAttempt, "github", github.state === "connected" ? "GitHub account connected." : "GitHub authorization is pending.")
      return github
    } catch (cause) {
      if (connectionAttempt) recordGitHubActivity(connectionAttempt, "github", "GitHub connection did not complete. You can try connecting again.", true)
      if (command === "connect_github" && sequence === githubMutationSequence) {
        try {
          const github = githubStateShape.parse(await native.invoke("read_github_state"))
          if (sequence === githubMutationSequence && snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, github } })
        } catch { /* Keep the last verified state if reading also fails. */ }
      }
      const message = `GitHub operation failed: ${errorMessage(cause)}`
      if (sequence === githubMutationSequence && snapshot.source) publish({ ...snapshot, error: message, source: { ...snapshot.source, github: { ...snapshot.source.github,
        ...(command !== "save_github_configuration" && { repositoryCatalogStatus: { status: "unavailable" as const, message, canRetry: command === "refresh_github_repositories" } }),
      } } })
      throw cause
    } finally {
      if (sequence === githubMutationSequence) githubMutationPending = false
    }
  }

  const applicationActions: ApplicationActions = {
    saveSecret: (request: SecretConfigurationRequest) => changeSecret("save_secret", { request }),
    removeSecret: (id: string) => changeSecret("remove_secret", { id }),
    retrySecret: (id: string) => changeSecret("retry_secret", { id }),
    refreshNetwork,
    saveNetworkPort: request => changeNetwork("save_network_port", { ...request }),
    removeNetworkPort: (workspace, port) => changeNetwork("remove_network_port", { workspace, port }),
    openNetworkPort: (workspace, port) => native.invoke<void>("open_network_port", { workspace, port }),
    listWorkspaceDirectory: async (workspace, path, offset, snapshotId) => directoryPageShape.parse(await native.invoke("list_workspace_directory", { workspace, path, offset, snapshotId: snapshotId ?? null })),
    retryRuntimeChecks: () => { void refresh() },
    saveMachineConfiguration,
    retryMachineConfiguration: (workspace) => {
      const operation = snapshot.source?.sandboxConfigurationOperation
      if (operation) void configureMachines(operation.candidate, workspace).catch(() => {})
    },
    pushRepository: (workspace, repositoryPath) => {
      void native.invoke("push_repository", { workspace, repositoryPath }).then(refresh).catch((cause) => {
        const message = `Repository push failed: ${errorMessage(cause)}`
        if (snapshot.source) publish({ ...snapshot, error: message, source: { ...snapshot.source,
          repositoryPushOperations: [...snapshot.source.repositoryPushOperations.filter((operation) => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath), { workspace, repositoryPath, commitCount: 0, status: "failed", message }],
        } })
      })
    },
    startWorkspace: (name) => workspaceAction("start", name),
    stopWorkspace: (name) => workspaceAction("stop", name),
    restartWorkspace: (name) => workspaceAction("restart", name),
    openTerminal: (name) => workspaceAction("open-terminal", name),
    openEditor: (name, path) => workspaceAction("open-editor", name, path ? { path } : undefined),
    connectGitHub: () => { void githubMutation("connect_github").catch(() => {}) },
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
    const previous = snapshot.backup.operation
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
    startBackup(destination, sandboxes) {
      if (pendingBackupOperation || snapshot.backup.operation?.kind === "running") return
      pendingBackupOperation = true
      showPendingBackup("backup", { name: "Backup", archivePath: "", completedLabel: "Not completed", size: "Unknown", destination, sandboxes })
      void native.invoke("start_backup", { destination, sandboxes }).then(() => { if (localBackupOperation?.kind === "running") dismissedBackupResults.clear(); return refresh() }).catch((cause) => {
        const archive: BackupArchive = { name: "Backup", archivePath: "", completedLabel: "Not completed", size: "Unknown", destination, sandboxes }
        localBackupOperation = backupFailure("backup", archive, errorMessage(cause))
        publish({ ...snapshot, backup: { ...snapshot.backup, operation: localBackupOperation } })
      }).finally(() => { pendingBackupOperation = false })
    },
    startRestore(archive, newName, sourceName) {
      if (pendingBackupOperation || snapshot.backup.operation?.kind === "running") return
      pendingBackupOperation = true
      showPendingBackup("restore", archive, newName)
      void native.invoke("start_restore", { archivePath: archive.archivePath, newName, ...(sourceName && { sourceName }) }).then(() => { if (localBackupOperation?.kind === "running") dismissedBackupResults.clear(); return refresh() }).catch((cause) => {
        localBackupOperation = backupFailure("restore", archive, errorMessage(cause), newName)
        publish({ ...snapshot, backup: { ...snapshot.backup, operation: localBackupOperation } })
      }).finally(() => { pendingBackupOperation = false })
    },
    cancelOperation() { void native.invoke("cancel_backup_operation").then(refresh).catch((cause) => reportUnavailable(`Backup cancellation failed: ${errorMessage(cause)} The operation may still be running.`)) },
    retryStart(name) {
      void native.invoke<unknown>("retry_workspace_start", { name }).then((result) => {
        const source = parseMutationSource(result)
        publish({ ...snapshot, source, error: null })
        return refresh()
      }).catch((cause) => setWorkspaceFailure("start", name, cause))
    },
    dismissOperation() {
      const operation = snapshot.backup.operation
      if (operation?.kind !== "result") return
      dismissedBackupResults.add(JSON.stringify(operation))
      localBackupOperation = null
      publish({ ...snapshot, backup: { ...snapshot.backup, operation: null } })
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
    quit: () => { void native.invoke("quit_app") },
    refresh: () => { void refresh() },
    openEditor: (name, path) => workspaceAction("open-editor", name, { path }),
    openSite: (workspace, port) => { void native.invoke("open_network_port", { workspace, port }).catch(() => reportUnavailable("Could not open this service. Check its port in Network.")) },
    dismissRepositoryPush: (workspace, repositoryPath) => {
      void native.invoke("dismiss_repository_push", { workspace, repositoryPath }).then(() => {
        if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source,
          repositoryPushOperations: snapshot.source.repositoryPushOperations.filter(operation => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath || operation.status === "pushing"),
        } })
        void refresh()
      }).catch(cause => console.error("Silo push dismissal:", errorMessage(cause)))
    },
  }

  return {
    getSnapshot: () => snapshot,
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
    dispose() { disposed = true; refreshSequence++; unlisten.forEach((stop) => stop()); window.removeEventListener("focus", refresh); listeners.clear() },
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
