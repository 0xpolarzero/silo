import type { SetupComputerConfiguration, SiloProgressEvent } from "@/contracts/silo"
import type {
  ApplicationGitHubComputerPolicy,
  ApplicationSource,
  ApplicationComputer,
  GitHubComputerOperation,
  RepositoryPushOperation,
  RuntimeRepairPresentation,
  ComputerConfigurationOperation,
  ComputerState,
} from "@/features/application/model/application-source"
import { fixtureComputerDefaults } from "@/fixtures/computer-configurations"
import { repositoryFixtures, type GitHubFixtureState, type ScenarioName } from "@/fixtures/scenarios"
import {
  applicationActivitiesForFixture,
  defaultApplicationActivities,
  type ActivityFixtureMode,
} from "@/fixtures/application-activity"

const [devComputer, playgroundsComputer, personalComputer] = fixtureComputerDefaults

export const computerFixtureModes = ["running", "starting", "stopped", "warning", "error"] as const
export type ComputerFixtureMode = (typeof computerFixtureModes)[number]

export const computerConfigurationFixtureModes = [
  "add-configuring",
  "add-networking",
  "add-verifying",
  "remove-pending",
  "computer-error",
] as const
export type ComputerConfigurationFixtureMode = (typeof computerConfigurationFixtureModes)[number]

export const systemIssueFixtureModes = ["needed", "checking", "runtime-missing"] as const
export type SystemIssueFixtureMode = (typeof systemIssueFixtureModes)[number]

export const repositoryPushFixtureModes = ["pushing", "succeeded", "failed"] as const
export type RepositoryPushFixtureMode = (typeof repositoryPushFixtureModes)[number]

export const githubManagementFixtureModes = [
  "idle",
  "applying",
  "succeeded",
  "failed",
  "disabled",
  "connected-empty",
  "missing-device-identity",
  "catalog-unavailable",
] as const
export type GitHubManagementFixtureMode = (typeof githubManagementFixtureModes)[number]

export function computerFixtureModeFromSearch(search: string): ComputerFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("computer-state")
  return computerFixtureModes.find((mode) => mode === requested)
}

export function computerConfigurationFixtureModeFromSearch(search: string): ComputerConfigurationFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("computer-change")
  return computerConfigurationFixtureModes.find((mode) => mode === requested)
}

export function systemIssueFixtureModeFromSearch(search: string): SystemIssueFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("system-issue")
  return systemIssueFixtureModes.find((mode) => mode === requested)
}

export function repositoryPushFixtureModeFromSearch(search: string): RepositoryPushFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("repository-push")
  return repositoryPushFixtureModes.find((mode) => mode === requested)
}

export function githubManagementFixtureModeFromSearch(search: string): GitHubManagementFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("github-operation")
  return githubManagementFixtureModes.find((mode) => mode === requested)
}

const baseComputers: ApplicationComputer[] = [
  {
    configuration: { ...devComputer },
    purpose: "Primary software development computer",
    state: "running",
    stateDetail: "Running for 2h 18m",
    freshness: "fresh",
    repositories: [
      { path: "acme/silo", branch: "main", ahead: 2, behind: 0, dirty: true, repository: "acme/silo", head: "4f1c2d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d" },
      { path: "acme/design-system", branch: "next", ahead: 0, behind: 1, dirty: false, repository: "acme/design-system", head: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b" },
    ],
    files: [
      {
        name: "projects",
        kind: "folder",
        children: [
          { name: "silo", kind: "folder", children: [{ name: "src", kind: "folder" }, { name: "README.md", kind: "file" }] },
          { name: "design-system", kind: "folder" },
        ],
      },
      { name: ".config", kind: "folder", children: [{ name: "git", kind: "folder" }] },
      { name: ".gitconfig", kind: "file" },
    ],
    ports: [
      { port: 3000, listening: true, configured: true, hostPort: 3000, scheme: "http" },
      { port: 5173, listening: false, configured: true, hostPort: 5173, scheme: "http" },
      { port: 8080, listening: false, configured: true, hostPort: 8080, scheme: "http" },
    ],
    logs: [
      { line: "19:18:42  web       Ready on http://0.0.0.0:3000", occurredAt: "2026-09-04T19:18:42Z" },
      { line: "19:18:40  postgres  Database system is ready", occurredAt: "2026-09-04T19:18:40Z" },
      { line: "19:18:37  worker    Connected to queue", occurredAt: "2026-09-04T19:18:37Z" },
    ],
    githubRepositories: ["acme/silo", "acme/design-system"],
    secretNames: ["PACKAGE_TOKEN", "DATABASE_URL"],
  },
  {
    configuration: { ...playgroundsComputer },
    purpose: "Experiments and disposable prototypes",
    state: "stopped",
    stateDetail: "Stopped yesterday",
    freshness: "fresh",
    repositories: [{ path: "acme/platform-tools", branch: "main", ahead: 0, behind: 0, dirty: false, repository: "acme/platform-tools", head: "1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c" }],
    files: [
      { name: "experiments", kind: "folder", children: [{ name: "typescript", kind: "folder" }, { name: "rust", kind: "folder" }] },
      { name: "scratch", kind: "folder", children: [{ name: "notes.md", kind: "file" }] },
      { name: "README.md", kind: "file" },
    ],
    ports: [],
    logs: [{ line: "17:02:11  silo  Computer stopped cleanly", occurredAt: "2026-09-03T17:02:11Z" }],
    githubRepositories: ["acme/platform-tools"],
    secretNames: ["PACKAGE_TOKEN"],
  },
  {
    configuration: { ...personalComputer },
    purpose: "Personal projects and services",
    state: "stopped",
    stateDetail: "Stopped 4 days ago",
    freshness: "fresh",
    repositories: [{ path: "taylor/docs-site", branch: "main", ahead: 0, behind: 0, dirty: false, repository: "taylor/docs-site", head: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00" }],
    files: [
      { name: "docs-site", kind: "folder", children: [{ name: "content", kind: "folder" }, { name: "public", kind: "folder" }] },
      { name: ".config", kind: "folder", children: [{ name: "silo", kind: "folder" }] },
      { name: "notes.md", kind: "file" },
    ],
    ports: [],
    logs: [{ line: "09:41:02  silo  Computer stopped cleanly", occurredAt: "2026-08-31T09:41:02Z" }],
    githubRepositories: ["taylor/docs-site"],
    secretNames: [],
  },
]

function computersForScenario(scenario: ScenarioName): ApplicationComputer[] {
  if (scenario === "complete") {
    return baseComputers.map((computer) => ({
      ...computer,
      state: "running",
      stateDetail: "Running and verified",
      ports: computer.ports.length > 0 ? computer.ports : [{ port: 3000, listening: true, configured: true, hostPort: 3000, scheme: "http" }],
      checkpoints: computer.configuration.name === "dev"
        ? [
            { id: "checkpoint-dev-1", name: "Before dependency upgrade", createdAt: "2026-09-04T18:00:00Z", scope: "full", reason: "manual" },
            { id: "checkpoint-dev-2", name: "Nightly disk checkpoint", createdAt: "2026-09-05T02:00:00Z", scope: "disk", reason: "manual" },
            { id: "checkpoint-dev-3", name: "Before restore", createdAt: "2026-09-05T09:30:00Z", scope: "full", reason: "before-restore" },
          ]
        : computer.checkpoints,
    }))
  }
  if (scenario === "bootstrap-failure") {
    return baseComputers.map((computer) => computer.configuration.name === "dev" ? {
      ...computer,
      state: "failed",
      stateDetail: "Start failed 3m ago",
      attention: { level: "error", message: "Candidate networking did not become ready." },
      freshness: "stale",
    } : computer)
  }
  return baseComputers
}

const fixtureStateDetails: Record<ComputerState, string> = {
  running: "Running and verified",
  starting: "Starting services",
  stopped: "Stopped",
  failed: "Start failed",
}

function computersForFixtureMode(computers: ApplicationComputer[], mode?: ComputerFixtureMode): ApplicationComputer[] {
  if (!mode) return computers
  const state: ComputerState = mode === "error" ? "failed" : mode === "warning" ? "stopped" : mode
  return computers.map((computer) => ({
    ...computer,
    state,
    stateDetail: fixtureStateDetails[state],
    attention: mode === "warning"
      ? { level: "warning", message: "Storage is almost full." }
      : mode === "error"
        ? { level: "error", message: "Candidate networking did not become ready." }
        : undefined,
    freshness: mode === "error" ? "stale" : "fresh",
  }))
}

const scratchComputer: SetupComputerConfiguration = {
  ...devComputer,
  id: "00000000-0000-4000-8000-000000000004",
  name: "scratch",
  cpus: 4,
  memoryGiB: 16,
  workspaceStorageGiB: 60,
  runtimeStorageGiB: 60,
}

const fixtureRevision = "a".repeat(64)

function progressEvent(step: string, computer: string, fraction: 0 | 1, message: string): SiloProgressEvent {
  return {
    schemaVersion: 1,
    type: "progress",
    requestId: "fixture-computer-configuration",
    phase: step === "computer-verification" ? "verification" : "computers",
    step,
    computer,
    revision: fixtureRevision,
    fraction,
    message,
    safeForDisplay: true,
  }
}

function configurationOperationForFixture(
  computers: ApplicationComputer[],
  mode?: ComputerConfigurationFixtureMode,
): ComputerConfigurationOperation | null {
  if (!mode) return null
  const configurations = computers.map(({ configuration }) => configuration)
  const candidate = {
    schemaVersion: 1 as const,
    configurations: mode === "remove-pending"
      ? configurations.filter(({ name }) => name !== "playgrounds")
      : [...configurations, scratchComputer],
  }
  const configured = progressEvent("computer-configuration", "scratch", 1, "Computer 'scratch' is configured.")
  const networkReady = progressEvent("computer-networking", "scratch", 1, "Candidate networking is ready for 'scratch'.")

  if (mode === "computer-error") {
    return {
      id: "fixture-computer-configuration",
      status: "failed",
      candidate,
      progressEvents: [configured, progressEvent("computer-networking", "scratch", 0, "Candidate networking failed for 'scratch'.")],
      result: null,
      error: {
        code: "SILO_CANDIDATE_NETWORKING_FAILED",
        message: "Networking failed for 'scratch'.",
        recovery: "Repair computer startup or SSH forwarding, then retry.",
        computer: "scratch",
        retryable: true,
      },
    }
  }

  const progressEvents = mode === "add-configuring"
    ? [progressEvent("computer-configuration", "scratch", 0, "Configuring computer 'scratch'.")]
    : mode === "add-networking"
      ? [configured, progressEvent("computer-networking", "scratch", 0, "Starting candidate networking for 'scratch'.")]
      : mode === "add-verifying"
        ? [configured, networkReady, progressEvent("computer-verification", "scratch", 0, "Verifying 'scratch'.")]
        : []

  return {
    id: "fixture-computer-configuration",
    status: "applying",
    candidate,
    progressEvents,
    result: null,
    error: null,
  }
}

const neededRuntimeRepair: RuntimeRepairPresentation = {
  status: "needed",
  reason: "Silo could not verify the bundled runtime used to manage computers.",
}

function runtimeRepairForFixture(
  scenario: ScenarioName,
  mode?: SystemIssueFixtureMode,
): RuntimeRepairPresentation | null {
  if (!mode) return scenario === "dependency-failure" ? neededRuntimeRepair : null
  if (mode === "needed") return neededRuntimeRepair
  if (mode === "checking") return { ...neededRuntimeRepair, checking: true }
  return {
    status: "unavailable",
    reason: "This app build is missing its bundled Silo runtime.",
    recovery: "Reinstall Silo from a complete app bundle. Keep your existing computers and settings.",
  }
}

function repositoryPushOperationsForFixture(mode?: RepositoryPushFixtureMode): RepositoryPushOperation[] {
  if (!mode) return []
  const operation = {
    computer: "dev",
    repositoryPath: "acme/silo",
    commitCount: 2,
  }
  if (mode === "pushing") return [{ ...operation, status: "pushing" }]
  if (mode === "succeeded") return [{ ...operation, status: "succeeded" }]
  return [{
    ...operation,
    status: "failed",
    message: "Push failed because the remote branch changed.",
    diagnosticDetails: [
      "Repository: acme/silo",
      "Branch: main",
      "The remote branch no longer matches the reviewed commit.",
    ].join("\n"),
  }]
}

const githubComputerPolicies: readonly ApplicationGitHubComputerPolicy[] = [
  {
    computer: "dev",
    identity: { name: "Taylor Example", email: "taylor@example.com", apply: true },
    repositories: [
      { repository: "acme/silo", allowPushes: true },
      { repository: "acme/design-system", allowPushes: false },
    ],
  },
  {
    computer: "playgrounds",
    identity: { name: "Taylor Example", email: "taylor@example.com", apply: false },
    repositories: [{ repository: "acme/platform-tools", allowPushes: false }],
  },
  {
    computer: "personal",
    identity: { name: "Taylor Example", email: "taylor@personal.dev", apply: true },
    repositories: [{ repository: "taylor/docs-site", allowPushes: true }],
  },
]

function githubComputerOperationsForFixture(mode?: GitHubManagementFixtureMode): readonly GitHubComputerOperation[] {
  if (!mode || mode === "idle" || mode === "disabled" || mode === "connected-empty" || mode === "missing-device-identity" || mode === "catalog-unavailable") return []
  if (mode === "applying") {
    return [{ computer: "dev", status: "applying", message: "Applying repository access…" }]
  }
  if (mode === "succeeded") {
    return [{ computer: "dev", status: "succeeded", message: "Repository access applied." }]
  }
  if (mode === "failed") {
    return [{
      computer: "dev",
      status: "failed",
      message: "Repository access could not be applied.",
      canRetry: true,
      diagnosticDetails: [
        "Computer: dev",
        "Repository: acme/silo",
        "The scoped repository grant could not be verified.",
      ].join("\n"),
    }]
  }
  return []
}

function githubComputerPoliciesForFixture(mode?: GitHubManagementFixtureMode): readonly ApplicationGitHubComputerPolicy[] {
  if (mode === "connected-empty") {
    return githubComputerPolicies.map((policy) => ({ ...policy, repositories: [] }))
  }
  if (mode === "missing-device-identity") {
    return githubComputerPolicies.map((policy) => ({
      ...policy,
      identity: { name: "", email: "", apply: false },
    }))
  }
  return githubComputerPolicies
}

export function applicationSourceForScenario(
  scenario: ScenarioName,
  githubState?: GitHubFixtureState,
  computerMode?: ComputerFixtureMode,
  computerConfigurationMode?: ComputerConfigurationFixtureMode,
  systemIssueMode?: SystemIssueFixtureMode,
  repositoryPushMode?: RepositoryPushFixtureMode,
  activityMode?: ActivityFixtureMode,
  activityStep = 0,
  githubManagementMode?: GitHubManagementFixtureMode,
): ApplicationSource {
  const githubConnectionState = githubState ?? "connected"
  const computers: ApplicationComputer[] = computersForFixtureMode(computersForScenario(scenario), computerMode).map((computer) => (
    repositoryPushMode === "succeeded" && computer.configuration.name === "dev"
      ? { ...computer, repositories: computer.repositories.map((repository) => repository.path === "acme/silo" ? { ...repository, ahead: 0 } : repository) }
      : githubManagementMode === "failed" && computer.configuration.name === "dev"
        ? { ...computer, attention: { level: "error", message: "GitHub access could not be applied." } }
      : computer
  ))
  // Deep-clone so a test that mutates its source cannot leak into the
  // module-level fixture data shared by every later test.
  return structuredClone({
    runtimeRepair: runtimeRepairForFixture(scenario, systemIssueMode),
    computers,
    activities: applicationActivitiesForFixture(
      activityMode,
      activityStep,
      scenario === "bootstrap-failure"
        ? [
            {
              id: "dev-failure",
              category: "computer",
              title: "Start failed",
              detail: "Candidate networking did not become ready.",
              occurredAt: "2026-09-04T15:59:00.000Z",
              time: "3m ago",
              tone: "danger",
              status: "completed",
              computer: "dev",
            },
            ...defaultApplicationActivities,
          ]
        : defaultApplicationActivities,
    ),
    computerConfigurationOperation: configurationOperationForFixture(computers, computerConfigurationMode),
    repositoryPushOperations: repositoryPushOperationsForFixture(repositoryPushMode),
    github: {
      state: githubConnectionState,
      account: githubConnectionState === "connected" ? "taylor" : undefined,
      accessEnabled: githubManagementMode !== "disabled",
      repositoryCatalog: githubManagementMode === "catalog-unavailable" ? [] : repositoryFixtures,
      repositoryCatalogStatus: githubManagementMode === "catalog-unavailable"
        ? { status: "unavailable", message: "GitHub repositories could not be loaded.", canRetry: true }
        : { status: "available" },
      deviceIdentity: githubManagementMode === "missing-device-identity"
        ? null
        : { name: "Taylor Example", email: "taylor@example.com" },
      computers: githubComputerPoliciesForFixture(githubManagementMode),
      computerOperations: githubComputerOperationsForFixture(githubManagementMode),
    },
    secrets: [
      { id: "package-token", name: "PACKAGE_TOKEN", computers: ["dev", "playgrounds"], allowedDomains: ["registry.npmjs.org"], state: "active" },
      { id: "database-url", name: "DATABASE_URL", computers: ["dev"], allowedDomains: ["db.example.test"], state: "restart-required" },
    ],
    backup: {
      lastArchive: "silo-2026-09-02.silo-backup",
      completedLabel: "Yesterday at 22:14",
      compressedSize: "38.4 GiB",
      destination: "External SSD / Silo Exports",
    },
    preferences: {
      launchAtLogin: true,
      startComputersAtLaunch: false,
      terminal: "Terminal",
      editor: "Visual Studio Code",
      browser: "Safari",
      reduceMotion: false,
    },
  } satisfies ApplicationSource)
}
