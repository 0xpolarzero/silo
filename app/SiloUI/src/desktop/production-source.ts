import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useSyncExternalStore } from "react"
import { z } from "zod"

import type { SetupMachineConfigurationRequest } from "@/contracts/silo"
import type { ApplicationActions, ApplicationSource, SecretConfigurationRequest } from "@/features/application/model/application-source"
import type { BackupArchive, BackupController, BackupOperation, BackupState } from "@/features/application/model/backup-source"
import type { StatusBarActions, StatusBarRoute } from "@/features/status-bar/status-bar-types"

type EventHandler = () => void

export interface ProductionBridge {
  invoke: <T>(command: string, arguments_?: Record<string, unknown>) => Promise<T>
  listen: (event: string, handler: EventHandler) => Promise<() => void>
}

const bridge: ProductionBridge = {
  invoke: (command, arguments_) => invoke(command, arguments_),
  listen: (event, handler) => listen(event, handler),
}

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
  github: z.object({ state: z.enum(["disconnected", "connecting", "connected"]) }).passthrough(),
  secrets: z.array(z.unknown()),
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
  z.object({ operation: z.enum(["backup", "restore"]), archive: backupArchiveShape, runningNames: z.array(z.string()), targetName: z.string().optional(), kind: z.literal("running"), progress: z.number().min(0).max(100), phases: z.array(backupPhaseShape) }).strict(),
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
  source: ApplicationSource | null
  backup: BackupState
  loading: boolean
  error: string | null
}

export function createProductionSource(native: ProductionBridge = bridge) {
  let snapshot: ProductionSnapshot = {
    source: null,
    backup: unavailableBackup("Backup state has not loaded. No sandbox data changed."),
    loading: true,
    error: null,
  }
  let disposed = false
  let refreshSequence = 0
  const unlisten: Array<() => void> = []
  const listeners = new Set<() => void>()
  const pendingWorkspaceActions = new Set<string>()
  let pendingBackupOperation = false
  let requestedOperation: { operation: "backup" | "restore"; archive: BackupArchive; targetName?: string } | null = null

  function publish(next: ProductionSnapshot) {
    if (disposed) return
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  function unreadableBackup(message: string): BackupState {
    const state = unavailableBackup(message)
    if (requestedOperation) state.operation = backupFailure(requestedOperation.operation, requestedOperation.archive, message, requestedOperation.targetName)
    return state
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
        if (backup.operation?.kind === "result") requestedOperation = null
      }
      catch (cause) { backup = unreadableBackup(`Silo returned invalid backup state: ${errorMessage(cause)} Refresh to confirm the operation result.`) }
    } else backup = unreadableBackup(`Silo could not read backup state: ${errorMessage(backupResult.reason)} Refresh to confirm the operation result.`)
    publish({ source, backup, loading: false, error })
  }

  async function initialize() {
    try {
      unlisten.push(await native.listen("silo://application-state-changed", () => { void refresh() }))
      unlisten.push(await native.listen("desktop:status-opened", () => { void refresh() }))
    } catch (cause) {
      unlisten.splice(0).forEach((stop) => stop())
      const error = `Silo could not subscribe to application updates: ${errorMessage(cause)}`
      publish({ ...snapshot, loading: false, error })
      throw new Error(error)
    }
    window.addEventListener("focus", refresh)
    await refresh()
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
    if (pendingWorkspaceActions.has(key)) return
    pendingWorkspaceActions.add(key)
    void native.invoke<unknown>("workspace_action", { action, name, ...extras })
      .then((result) => {
        const source = parseApplicationSource(result)
        publish({ ...snapshot, source, error: null })
        return refresh()
      })
      .catch((cause) => setWorkspaceFailure(action, name, cause))
      .finally(() => pendingWorkspaceActions.delete(key))
  }

  async function configureMachines(request: SetupMachineConfigurationRequest) {
    try {
      const result = parseApplicationSource(await native.invoke("save_machine_configuration", { request }))
      publish({ ...snapshot, source: result, error: null })
      await refresh()
      return result
    } catch (cause) {
      if (snapshot.source) publish({ ...snapshot, source: { ...snapshot.source, workspaces: snapshot.source.workspaces.map((workspace) => ({ ...workspace, freshness: "stale" })), sandboxConfigurationOperation: {
          id: `save-failed-${Date.now()}`,
          status: "failed",
          candidate: request,
          progressEvents: [],
          result: null,
          error: { code: "native_bridge_failed", message: errorMessage(cause), recovery: "Refresh to confirm the current configuration before retrying.", workspace: null, retryable: true },
        } } })
      throw cause
    }
  }

  function saveMachineConfiguration(request: SetupMachineConfigurationRequest) {
    void configureMachines(request).catch(() => {})
  }

  const applicationActions: ApplicationActions = {
    saveSecret: (_request: SecretConfigurationRequest) => reportUnavailable("Secret changes are not available in this Silo build. No secret was saved."),
    removeSecret: () => reportUnavailable("Secret changes are not available in this Silo build. No secret was removed."),
    repairRuntime: () => reportUnavailable("Runtime repair is not available in this Silo build. No installation files changed."),
    saveMachineConfiguration,
    retryMachineConfiguration: () => {
      const operation = snapshot.source?.sandboxConfigurationOperation
      if (operation) saveMachineConfiguration(operation.candidate)
    },
    pushRepository: () => reportUnavailable("Repository pushes are not available in this Silo build. No commits were pushed."),
    startWorkspace: (name) => workspaceAction("start", name),
    pauseWorkspace: (name) => workspaceAction("pause", name),
    stopWorkspace: (name) => workspaceAction("stop", name),
    restartWorkspace: (name) => workspaceAction("restart", name),
    openTerminal: (name) => workspaceAction("open-terminal", name),
    openEditor: (name) => workspaceAction("open-editor", name),
    connectGitHub: () => reportUnavailable("GitHub changes are not available in this Silo build. No account was connected."),
    disconnectGitHub: () => reportUnavailable("GitHub changes are not available in this Silo build. No account was disconnected."),
    setGitHubAccessEnabled: () => reportUnavailable("GitHub changes are not available in this Silo build. Repository access did not change."),
    saveGitHubConfiguration: () => reportUnavailable("GitHub changes are not available in this Silo build. Repository access did not change."),
    retryGitHubConfiguration: () => reportUnavailable("GitHub changes are not available in this Silo build. Repository access did not change."),
    retryGitHubRepositoryCatalog: () => reportUnavailable("GitHub repository refresh is not available in this Silo build."),
  }

  function backupFailure(operation: "backup" | "restore", archive: BackupArchive, message: string, targetName?: string): BackupOperation {
    return { operation, archive, runningNames: [], targetName, kind: "result", outcome: "failed", title: `${operation === "backup" ? "Backup" : "Restore"} failed`, message, detail: "No successful result was recorded." }
  }

  const backupActions: BackupController["actions"] = {
    async chooseDestination() {
      const selected = await native.invoke<string | null>("choose_backup_destination")
      if (selected) await refresh()
      return selected
    },
    async chooseArchive() {
      const archivePath = await native.invoke<string | null>("choose_backup_archive")
      if (!archivePath) return null
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
      if (pendingBackupOperation) return
      pendingBackupOperation = true
      requestedOperation = { operation: "backup", archive: { name: "Backup", archivePath: "", completedLabel: "Not completed", size: "Unknown", destination, sandboxes } }
      void native.invoke("start_backup", { destination, sandboxes }).then(refresh).catch((cause) => {
        const archive: BackupArchive = { name: "Backup", archivePath: "", completedLabel: "Not completed", size: "Unknown", destination, sandboxes }
        publish({ ...snapshot, backup: { ...snapshot.backup, operation: backupFailure("backup", archive, errorMessage(cause)) } })
      }).finally(() => { pendingBackupOperation = false })
    },
    startRestore(archive, newName, sourceName) {
      if (pendingBackupOperation) return
      pendingBackupOperation = true
      requestedOperation = { operation: "restore", archive, targetName: newName }
      void native.invoke("start_restore", { archivePath: archive.archivePath, newName, ...(sourceName && { sourceName }) }).then(refresh).catch((cause) => {
        publish({ ...snapshot, backup: { ...snapshot.backup, operation: backupFailure("restore", archive, errorMessage(cause), newName) } })
      }).finally(() => { pendingBackupOperation = false })
    },
    cancelOperation() { void native.invoke("cancel_backup_operation").then(refresh).catch((cause) => reportUnavailable(`Backup cancellation failed: ${errorMessage(cause)} The operation may still be running.`)) },
    retryStart(name) {
      void native.invoke<unknown>("retry_workspace_start", { name }).then((result) => {
        const source = parseApplicationSource(result)
        publish({ ...snapshot, source, error: null })
        return refresh()
      }).catch((cause) => setWorkspaceFailure("start", name, cause))
    },
    dismissOperation() { void native.invoke("dismiss_backup_operation").then(() => { requestedOperation = null; return refresh() }).catch((cause) => reportUnavailable(`The backup result could not be dismissed: ${errorMessage(cause)}`)) },
  }

  const statusActions: StatusBarActions = {
    startWorkspace: applicationActions.startWorkspace,
    stopWorkspace: applicationActions.stopWorkspace,
    restartWorkspace: applicationActions.restartWorkspace,
    openTerminal: applicationActions.openTerminal,
    pushRepository: applicationActions.pushRepository,
    openSilo: (_route?: StatusBarRoute) => { void native.invoke("open_main").catch((cause) => console.error("Silo main window:", errorMessage(cause))) },
    quit: () => { void native.invoke("quit_app") },
    refresh: () => { void refresh() },
    openEditor: (name, path) => workspaceAction("open-editor", name, { path }),
    openSite: (name, port) => workspaceAction("open-site", name, { port }),
    dismissRepositoryPush: () => {},
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    initialize,
    refresh,
    configureMachines,
    configureIdentities: (identities: Array<{ workspace: string; name: string; email: string; apply: boolean }>) => native.invoke("configure_workspace_identities", { identities }),
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
