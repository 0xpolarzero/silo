import type { DirectoryLoader } from "./directory-store"
import type {
  SetupMachineConfiguration,
  SetupMachineConfigurationRequest,
  SiloBootstrapResult,
  SiloProgressEvent,
  SiloProtocolError,
} from "@/contracts/silo"
import type { ApplicationPreferenceSelection } from "@/features/preferences/model/application-preferences"

export type ApplicationTab = "workspaces" | "github" | "secrets" | "backup" | "system" | "settings"
export type SettingsSection = "general" | "notifications"
export type WorkspaceSection = "overview" | "files" | "logs" | "network" | "activity"
export type WorkspaceDetailSection = Exclude<WorkspaceSection, "overview">
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
}

export type RepositoryPushOperation = {
  workspace: string
  repositoryPath: string
  commitCount: number
} & (
  | { status: "pushing" }
  | { status: "succeeded" }
  | { status: "failed"; message: string; diagnosticDetails?: string }
)

export interface ApplicationLog {
  line: string
  occurredAt: string
}

export interface ApplicationPort {
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
}

export interface ApplicationWorkspace {
  machine: SetupMachineConfiguration
  purpose: string
  state: WorkspaceState
  stateDetail: string
  lifecycleAction?: "start" | "stop" | "restart"
  attention?: {
    level: "warning" | "error"
    message: string
  }
  freshness: "fresh" | "stale"
  host: string
  repositories: ApplicationRepository[]
  files: ApplicationFileEntry[]
  ports: ApplicationPort[]
  logs: ApplicationLog[]
  githubRepositories: string[]
  secretNames: string[]
}

export interface ApplicationSecret {
  id: string
  name: string
  workspaces: string[]
  allowedDomains: string[]
  state: "active" | "restart-required"
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
  repositoryMode?: "selected" | "all"
  allRepositoriesAllowChanges?: boolean
  workspace: string
  identity: ApplicationWorkspaceGitIdentity
  repositories: readonly ApplicationGitHubRepositoryPolicy[]
}

export interface ApplicationGitHubConfiguration {
  accessEnabled: boolean
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
  runtimeRepair: RuntimeRepairPresentation | null
  workspaces: ApplicationWorkspace[]
  activities: ApplicationActivity[]
  sandboxConfigurationOperation: SandboxConfigurationOperation | null
  repositoryPushOperations: RepositoryPushOperation[]
  github: {
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
  listWorkspaceDirectory?: DirectoryLoader
  saveSecret: (request: SecretConfigurationRequest) => Promise<void> | void
  removeSecret: (id: string) => Promise<void> | void
  retrySecret?: (id: string) => Promise<void> | void
  retryRuntimeChecks: () => void
  saveMachineConfiguration: (request: SetupMachineConfigurationRequest) => void
  retryMachineConfiguration: (workspace: string) => void
  pushRepository: (workspace: string, repositoryPath: string) => void
  startWorkspace: (workspace: string) => void
  stopWorkspace: (workspace: string) => void
  restartWorkspace: (workspace: string) => void
  openTerminal: (workspace: string) => void
  openEditor: (workspace: string) => void
  connectGitHub?: () => void
  disconnectGitHub?: () => void
  setGitHubAccessEnabled?: (enabled: boolean) => void
  saveGitHubConfiguration?: (configuration: ApplicationGitHubConfiguration) => void | Promise<void>
  retryGitHubConfiguration?: (workspace?: string) => void
  retryGitHubRepositoryCatalog?: () => void
}
