import type { OperationQueue } from "./operation-queue"
import type { WorkspaceStorageState } from "./workspace-storage"
import type { CheckpointUsage, PendingCheckpointRestore, UnfinishedRestore, WorkspaceCheckpoint, WorkspaceCheckpointOperation } from "./checkpoint-source"
import type { LogLoader, LogQuery } from "./logs"
import type { RemoteComputer, RemoteManagement, WorkspaceComputer } from "./remote-computers"
import type { DirectoryLoader } from "./directory-store"
import type {
  SetupMachineConfiguration,
  SetupMachineConfigurationRequest,
  SiloBootstrapResult,
  SiloProgressEvent,
  SiloProtocolError,
} from "@/contracts/silo"
import type { ApplicationPreferenceSelection } from "@/features/preferences/model/application-preferences"

export type ApplicationTab = "workspaces" | "github" | "secrets" | "system" | "settings"
export type SettingsSection = "general" | "computers" | "notifications"
export type WorkspaceSection = "overview" | "files" | "logs" | "network" | "activity"
export type WorkspaceDetailSection = Exclude<WorkspaceSection, "overview">
/** Tabs on a single sandbox's detail page, reached from the Sandboxes overview. */
export type SandboxDetailTab = "overview" | "checkpoints" | "storage" | "access"
export type WorkspaceState = "running" | "starting" | "stopped" | "failed"

export type RuntimeRepairPresentation = {
  status: "needed" | "unavailable"
  reason: string
  recovery?: string
  checking?: boolean
}

export type ActiveRuntimeRepairPresentation = RuntimeRepairPresentation

export type SandboxConfigurationOperation =
  | {
      id: string
      status: "applying"
      candidate: SetupMachineConfigurationRequest
      progressEvents: readonly SiloProgressEvent[]
      result: null
      error: null
    }
  | {
      id: string
      status: "awaiting-approval"
      candidate: SetupMachineConfigurationRequest
      progressEvents: readonly SiloProgressEvent[]
      result: SiloBootstrapResult
      error: null
    }
  | {
      id: string
      status: "failed"
      candidate: SetupMachineConfigurationRequest
      progressEvents: readonly SiloProgressEvent[]
      result: null
      error: SiloProtocolError
    }

export interface ApplicationRepository {
  path: string
  branch: string
  ahead: number
  behind: number
  dirty: boolean
  /** GitHub `owner/name` of the `origin` remote; absent when it is not a GitHub repository or the owner predates push binding. */
  repository?: string | null
  /** Commit at the tip of `branch`. */
  head?: string | null
}

/** The repository, branch and commit the user confirmed; the host pushes exactly these or nothing. */
export interface RepositoryPushTarget {
  repository: string
  branch: string
  commit: string
}

export type RepositoryPushOperation = {
  /** The host-owned push this result belongs to; older hosts may omit it. */
  operationId?: string
  workspace: string
  repositoryPath: string
  commitCount: number
  /** What this push publishes, as confirmed by the user. */
  target?: RepositoryPushTarget
} & (
  | { status: "pushing"; message?: string }
  | { status: "unknown"; message: string }
  | { status: "succeeded" }
  | { status: "failed"; message: string; diagnosticDetails?: string }
)

export interface ApplicationLog {
  line: string
  occurredAt: string
}

export interface NetworkPort {
  configuredHostPort?: number | null
  port: number
  hostPort: number | null
  scheme: "http" | "https" | null
  state: "reachable" | "waiting" | "unpublished" | "unknown"
  configured: boolean
  message?: string | null
}
export interface NetworkState { workspaces: { workspace: string; ports: NetworkPort[]; error: string | null; /** Host name published websites open at; absent means 127.0.0.1. */ host?: string | null }[] }
export interface SshAccessWorkspace {
  unavailable?: string
  workspace: string; enabled: boolean; port: number; bindAddress: string; keys: string[]
  state: "disabled" | "waiting" | "listening" | "error"; message: string | null
  fingerprint: string | null; computerName: string; addresses: string[]
  /** Guest account SSH clients log in as; older owners omit it. */
  user?: string
}
export interface SshAccessState { workspaces: SshAccessWorkspace[] }
export type SshAccessRequest = Pick<SshAccessWorkspace, "workspace" | "enabled" | "port" | "bindAddress" | "keys">
export interface NetworkPortRequest { workspace: string; port: number; hostPort: number | null; scheme: "http" | "https" | null }

export interface ApplicationPort {
  hostPort?: number | null
  scheme?: "http" | "https" | null
  configured?: boolean
  port: number
  listening: boolean | null
}

export interface ApplicationFileEntry {
  name: string
  kind: "folder" | "file"
  children?: ApplicationFileEntry[]
}

export type ApplicationActivityCategory = "sandbox" | "git" | "backup" | "secrets" | "github" | "system"

export type ApplicationActivityStatus = "running" | "completed"

export interface ApplicationActivity {
  id: string
  category: ApplicationActivityCategory
  title: string
  detail: string
  occurredAt: string
  time: string
  tone: "success" | "neutral" | "warning" | "danger"
  status: ApplicationActivityStatus
  workspace?: string
  progress?: number
  progressLabel?: string
  /** A start, stop or restart the user cancelled: neither a failure nor a success. */
  cancelled?: boolean
}

export interface ApplicationWorkspace {
  computer?: WorkspaceComputer
  machine: SetupMachineConfiguration
  purpose: string
  state: WorkspaceState
  stateDetail: string
  canDismissError?: boolean
  lifecycleFailure?: string
  /** The lifecycle action that failed, so the UI can offer a matching Retry that
   * re-submits the same intent (re-reading fresh state server-side). */
  lifecycleFailureAction?: "start" | "stop" | "restart" | "dismiss-error"
  /** True when the last lifecycle attempt was cancelled by the user rather than
   * failing. Rendered as a neutral, retryable state instead of an error. */
  lifecycleFailureCancelled?: boolean
  lifecycleAction?: "start" | "stop" | "restart" | "dismiss-error"
  /** Native snapshot reads are settling after an operation. */
  settling?: boolean
  attention?: {
    level: "warning" | "error"
    message: string
  }
  freshness: "fresh" | "stale"
  /** The native read overlapped an operation; runtime fields retain their last settled values. */
  settling?: boolean
  host: string
  repositories: ApplicationRepository[]
  files: ApplicationFileEntry[]
  ports: ApplicationPort[]
  logs: ApplicationLog[]
  githubRepositories: string[]
  secretNames: string[]
  checkpoints?: WorkspaceCheckpoint[]
  checkpointOperation?: WorkspaceCheckpointOperation | null
  pendingCheckpointRestore?: PendingCheckpointRestore | null
  unfinishedRestore?: UnfinishedRestore | null
}

export interface ApplicationSecret {
  id: string
  name: string
  workspaces: string[]
  allowedDomains: string[]
  state: "active" | "applying" | "restart-required"
  pendingWorkspaces?: string[]
  error?: string
  removing?: boolean
}

// Values travel only with a save request, never in the published secret metadata.
export type SecretConfigurationRequest = {
  name: string
  workspaces: string[]
  allowedDomains: string[]
} & ({ operation: "add"; value: string } | { operation: "edit"; id: string; value?: string })

export interface ApplicationGitIdentity {
  name: string
  email: string
}

export interface ApplicationWorkspaceGitIdentity extends ApplicationGitIdentity {
  apply: boolean
}

export interface ApplicationGitHubRepositoryPolicy {
  repository: string
  allowPushes: boolean
}

export interface ApplicationGitHubWorkspacePolicy {
  authenticationMethod?: "oauth" | "token"
  repositoryMode?: "selected" | "all"
  allRepositoriesAllowChanges?: boolean
  workspace: string
  identity: ApplicationWorkspaceGitIdentity
  repositories: readonly ApplicationGitHubRepositoryPolicy[]
}

/**
 * A save of sandbox GitHub choices. `workspaces` lists only the sandboxes being changed;
 * other sandboxes keep their saved choices. `baseRevision` is the `policyRevision` the
 * edit was based on, so a change made meanwhile (such as a fork's copied assignment) is
 * not overwritten. Access on/off is changed only through `setGitHubAccessEnabled`.
 */
export interface ApplicationGitHubConfiguration {
  baseRevision?: number
  hostIdentity: ApplicationGitIdentity | null
  workspaces: readonly ApplicationGitHubWorkspacePolicy[]
}

export type GitHubWorkspaceOperation = {
  workspace: string
  message: string
} & (
  | { status: "applying" }
  | { status: "succeeded" }
  | { status: "failed"; canRetry: true; diagnosticDetails?: string }
)

export type GitHubRepositoryCatalogStatus =
  | { status: "available" }
  | { status: "unavailable"; message: string; canRetry: boolean }

export interface ApplicationSource {
  remoteComputers?: RemoteComputer[]
  remoteManagement?: RemoteManagement
  remoteManagementError?: string
  /** Silo could not read its list of connected computers; the listed ones are the last known. */
  remoteComputersError?: string
  sshAccess?: SshAccessState
  sshAccessError?: string | null
  network?: NetworkState
  networkError?: string | null
  runtimeRepair: RuntimeRepairPresentation | null
  /** Ordered admission queue for VM-changing operations on this computer. */
  operationQueue?: OperationQueue
  workspaces: ApplicationWorkspace[]
  activities: ApplicationActivity[]
  sandboxConfigurationOperation: SandboxConfigurationOperation | null
  repositoryPushOperations: RepositoryPushOperation[]
  github: {
    personalToken?: { state: "connected" | "disconnected"; saved: boolean; account?: string; message?: string }
    policyRevision?: number
    state: "disconnected" | "connecting" | "connected"
    account?: string
    /** Optional until every native source publishes the richer management snapshot. */
    accessEnabled?: boolean
    repositoryCatalog?: readonly string[]
    repositoryCatalogStatus?: GitHubRepositoryCatalogStatus
    hostIdentity?: ApplicationGitIdentity | null
    workspaces?: readonly ApplicationGitHubWorkspacePolicy[]
    workspaceOperations?: readonly GitHubWorkspaceOperation[]
  }
  secrets: ApplicationSecret[]
  backup: {
    lastArchive: string
    completedLabel: string
    compressedSize: string
    destination: string
  }
  /** Operation-owned capacity evidence. Fixtures set this only through an explicit scenario. */
  resourceNotice?:
    | { kind: "create-storage"; sandbox: string; requiredGB: number; availableGB: number; volume: string }
    | { kind: "start-memory"; sandbox: string; memoryGiB: number }
  vmOperationsUnavailable?: string
  preferences: ApplicationPreferenceSelection & {
    launchAtLogin: boolean
    startWorkspacesAtLaunch: boolean
    startupWorkspaceIds?: string[]
    reduceMotion: boolean
  }
}

export interface ApplicationActions {
  createCheckpoint?: (workspace: string, name: string) => Promise<void>
  forkCheckpoint?: (workspace: string, checkpointId: string | null, newName: string) => Promise<void>
  restoreCheckpoint?: (workspace: string, checkpointId: string) => Promise<void>
  /** Give up an unfinished Restore of a sandbox on this computer, keeping its current state. */
  abandonRestore?: (workspace: string) => Promise<void>
  /** Delete one checkpoint of a sandbox on this computer. */
  deleteCheckpoint?: (workspace: string, checkpointId: string) => Promise<void>
  /** Checkpoint sizes and Delete availability for a sandbox on this computer, by its ID. */
  readCheckpointUsage?: (workspaceId: string) => Promise<CheckpointUsage>
  readWorkspaceStorage?: (workspaceId: string) => Promise<WorkspaceStorageState>
  reclaimWorkspaceStorage?: (workspaceId: string) => Promise<WorkspaceStorageState>
  refreshRepositories?: () => Promise<void>
  openDesktop?: (workspace: string) => void | Promise<void>
  cancelLogExport?: () => Promise<void>
  queryLogs?: LogLoader
  exportLogs?: (requests: LogQuery[]) => Promise<boolean>
  setRemoteManagement?: (enabled: boolean) => Promise<void>
  setupComputerKey?: (address: string) => Promise<void>
  authorizeComputer?: (address: string) => Promise<void>
  connectComputer?: (address: string, options?: { replaceAddress?: boolean }) => Promise<void>
  removeComputer?: (hostId: string) => Promise<void>
  saveRemoteMachine?: (hostId: string, machine: SetupMachineConfiguration, expected?: SetupMachineConfiguration) => Promise<void>
  deleteRemoteMachine?: (hostId: string, machine: SetupMachineConfiguration) => Promise<void>
  sshConnection?: (workspace: string, download: boolean, network?: boolean) => Promise<string | null>
  refreshSshAccess?: () => Promise<void>
  saveSshAccess?: (request: SshAccessRequest) => Promise<void>
  refreshNetwork?: () => Promise<void>
  saveNetworkPort?: (request: NetworkPortRequest) => Promise<void>
  removeNetworkPort?: (workspace: string, port: number) => Promise<void>
  openNetworkPort?: (workspace: string, port: number) => Promise<void>
  listWorkspaceDirectory?: DirectoryLoader
  saveSecret: (request: SecretConfigurationRequest) => Promise<void> | void
  removeSecret: (id: string) => Promise<void> | void
  retrySecret?: (id: string) => Promise<void> | void
  retryRuntimeChecks: () => void
  saveMachineConfiguration: (request: SetupMachineConfigurationRequest, baseline?: SetupMachineConfiguration[]) => Promise<void> | void
  dismissMachineConfigurationError: () => void
  retryMachineConfiguration: (workspace: string) => void
  dismissRepositoryPush?: (workspace: string, repositoryPath: string) => void
  /** Push exactly the confirmed `target`; the host aborts if the sandbox no longer matches it. */
  pushRepository: (workspace: string, repositoryPath: string, target: RepositoryPushTarget) => void
  startWorkspace: (workspace: string) => void
  stopWorkspace: (workspace: string) => void
  restartWorkspace: (workspace: string) => void
  /** Cancel a queued or cancellable running operation by its operation-queue id. */
  cancelOperation?: (id: number) => void
  dismissWorkspaceError: (workspace: string) => void
  openTerminal: (workspace: string) => void
  openEditor: (workspace: string, path?: string) => void
  cancelGitHubConnection?: () => void
  reopenGitHubAuthorization?: () => void
  manageGitHubRepositories?: () => void
  saveGitHubPersonalToken?: (token: string) => Promise<void>
  removeGitHubPersonalToken?: () => Promise<void>
  connectGitHub?: () => void
  disconnectGitHub?: () => void
  setGitHubAccessEnabled?: (enabled: boolean) => void
  saveGitHubConfiguration?: (configuration: ApplicationGitHubConfiguration) => void | Promise<void>
  retryGitHubConfiguration?: (workspace?: string) => void
  retryGitHubRepositoryCatalog?: () => void
}
