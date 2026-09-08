import {
  type SiloBootstrapConfiguration,
  type SiloPreflightCheck,
  type SiloProgressEvent,
} from "@/contracts/silo"
import { parseOnboardingSource, type OnboardingSource } from "@/features/onboarding/model/onboarding-source"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"

export const scenarioNames = ["running", "complete", "dependency-failure", "bootstrap-failure", "stress-running"] as const
export type ScenarioName = (typeof scenarioNames)[number]

export const githubFixtureStates = ["disconnected", "connecting", "connected"] as const
export type GitHubFixtureState = (typeof githubFixtureStates)[number]

export const repositoryFixtures = [
  "acme/silo",
  "acme/design-system",
  "acme/platform-tools",
  "taylor/docs-site",
] as const

const revision = "9f3b7f095c93fced946f31c2847ad6f147e9d35ca91949845f959819f547440d"
const requestId = "setup-bootstrap-20260903"

const stressBootstrapConfiguration = {
  schemaVersion: 1,
  workspaces: [
    { name: "dev", cpu: 8, cpuCeiling: 12, memoryGiB: 32, memoryCeilingGiB: 48, workspaceStorageGiB: 120, runtimeStorageGiB: 100 },
    { name: "playgrounds", cpu: 4, cpuCeiling: 12, memoryGiB: 32, memoryCeilingGiB: 48, workspaceStorageGiB: 60, runtimeStorageGiB: 60 },
    { name: "personal", cpu: 6, cpuCeiling: 12, memoryGiB: 16, memoryCeilingGiB: 32, workspaceStorageGiB: 100, runtimeStorageGiB: 80 },
    { name: "docs-build", cpu: 4, cpuCeiling: 8, memoryGiB: 16, memoryCeilingGiB: 32, workspaceStorageGiB: 60, runtimeStorageGiB: 60 },
    { name: "client-alpha-integration", cpu: 8, cpuCeiling: 12, memoryGiB: 32, memoryCeilingGiB: 48, workspaceStorageGiB: 100, runtimeStorageGiB: 80 },
    { name: "qa-macos", cpu: 4, cpuCeiling: 8, memoryGiB: 16, memoryCeilingGiB: 32, workspaceStorageGiB: 60, runtimeStorageGiB: 60 },
    { name: "qa-linux", cpu: 4, cpuCeiling: 8, memoryGiB: 16, memoryCeilingGiB: 32, workspaceStorageGiB: 60, runtimeStorageGiB: 60 },
    { name: "release", cpu: 8, cpuCeiling: 12, memoryGiB: 32, memoryCeilingGiB: 48, workspaceStorageGiB: 100, runtimeStorageGiB: 80 },
    { name: "data-lab", cpu: 12, cpuCeiling: 12, memoryGiB: 48, memoryCeilingGiB: 48, workspaceStorageGiB: 120, runtimeStorageGiB: 120 },
    { name: "api-benchmarks", cpu: 12, cpuCeiling: 12, memoryGiB: 32, memoryCeilingGiB: 48, workspaceStorageGiB: 100, runtimeStorageGiB: 80 },
    { name: "customer-demo", cpu: 6, cpuCeiling: 8, memoryGiB: 16, memoryCeilingGiB: 32, workspaceStorageGiB: 80, runtimeStorageGiB: 60 },
    { name: "security-review", cpu: 8, cpuCeiling: 12, memoryGiB: 32, memoryCeilingGiB: 48, workspaceStorageGiB: 100, runtimeStorageGiB: 80 },
  ],
} satisfies SiloBootstrapConfiguration

const bootstrapConfiguration = {
  schemaVersion: 1,
  workspaces: productionMachineDefaults.map((machine) => ({
    name: machine.name,
    cpu: machine.cpus,
    cpuCeiling: machine.maxCPUs,
    memoryGiB: machine.memoryGiB,
    memoryCeilingGiB: machine.maxMemoryGiB,
    workspaceStorageGiB: machine.workspaceStorageGiB,
    runtimeStorageGiB: machine.runtimeStorageGiB,
  })),
} satisfies SiloBootstrapConfiguration

const passingPreflightChecks = [
  { id: "system-os", title: "Supported OS", status: "pass", detail: "macOS 15.6 · Apple silicon", remediation: null },
  { id: "system-virtualization", title: "Virtualization", status: "pass", detail: "Apple Hypervisor available", remediation: null },
  { id: "runtime-microsandbox", title: "MicroSandbox runtime", status: "pass", detail: "Bundled msb 0.6.17 · libkrunfw 5.6.1", remediation: null },
  { id: "tool-git", title: "Git", status: "pass", detail: "Bundled Git 2.53.0", remediation: null },
  { id: "tool-git-lfs", title: "Git LFS", status: "pass", detail: "Bundled Git LFS 3.7.1", remediation: null },
] satisfies SiloPreflightCheck[]

function progress(
  message: string,
  step: string,
  workspace: string,
  fraction: number,
  safeForDisplay = true,
): SiloProgressEvent {
  return {
    schemaVersion: 1,
    type: "progress",
    requestId,
    phase: step === "workspace-verification" ? "verification" : "workspaces",
    step,
    workspace,
    revision,
    fraction,
    message,
    safeForDisplay,
  }
}

function configuredEvents(configuration: SiloBootstrapConfiguration) {
  return configuration.workspaces.flatMap(({ name }) => [
    progress(`Configuring sandbox '${name}'.`, "workspace-configuration", name, 0),
    progress(`Sandbox '${name}' is configured.`, "workspace-configuration", name, 1),
  ])
}

function networkedEvents(configuration: SiloBootstrapConfiguration) {
  return configuration.workspaces.flatMap(({ name }) => [
    progress(`Starting candidate networking for '${name}'.`, "workspace-networking", name, 0),
    progress(`Candidate networking is ready for '${name}'.`, "workspace-networking", name, 1),
  ])
}

function verifyingEvents(configuration: SiloBootstrapConfiguration, readyCount: number) {
  const currentWorkspace = configuration.workspaces[readyCount].name
  return [
    ...configuredEvents(configuration),
    ...networkedEvents(configuration),
    ...configuration.workspaces.slice(0, readyCount).flatMap(({ name }) => [
      progress(`Verifying '${name}'.`, "workspace-verification", name, 0),
      progress(`Verification passed for '${name}'.`, "workspace-verification", name, 1),
    ]),
    progress("Internal verification path is not safe for display.", "workspace-verification", currentWorkspace, 0, false),
    progress(`Verifying '${currentWorkspace}'.`, "workspace-verification", currentWorkspace, 0),
  ]
}

const runningEvents = verifyingEvents(bootstrapConfiguration, 2)

const completeEvents = bootstrapConfiguration.workspaces.flatMap(({ name }) => [
  progress(`Sandbox '${name}' is configured.`, "workspace-configuration", name, 1),
  progress(`Candidate networking is ready for '${name}'.`, "workspace-networking", name, 1),
  progress(`Verification passed for '${name}'.`, "workspace-verification", name, 1),
]) satisfies SiloProgressEvent[]

const runningSource = {
  machineConfigurations: productionMachineDefaults.map((machine) => ({ ...machine })),
  bootstrapConfiguration,
  bootstrapState: {
    phase: "workspaces",
    startedAt: 810129582,
    updatedAt: 810129720,
    completedPhases: ["welcome", "preflight", "toolchain", "hostIntegration"],
    phaseDurations: { preflight: 1.4, toolchain: 0.8, hostIntegration: 0.6 },
  },
  preflightChecks: passingPreflightChecks,
  progressEvents: runningEvents,
  githubPolicies: [{
    workspace: "dev",
    repositories: [{
      workspace: "dev",
      repositoryID: 1001,
      fullName: "acme/silo",
      ownerID: 42,
      ownerLogin: "acme",
      ownerType: "Organization",
      mode: "read-only",
    }],
  }],
  currentHostGitIdentity: {
    name: "Taylor Example",
    email: "taylor@example.com",
  },
  applicationPreferences: {
    terminal: "Terminal",
    editor: "Visual Studio Code",
    browser: "Safari",
  },
  bootstrapResult: null,
  error: null,
} satisfies OnboardingSource

const completeSource = {
  ...runningSource,
  bootstrapState: {
    phase: "complete",
    startedAt: 810129300,
    updatedAt: 810129720,
    completedPhases: ["welcome", "preflight", "toolchain", "hostIntegration", "workspaces", "github", "identity", "complete"],
    workspaceConfigurations: bootstrapConfiguration.workspaces.map((workspace, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: workspace.name,
      cpus: workspace.cpu,
      maxCPUs: workspace.cpuCeiling,
      memoryGiB: workspace.memoryGiB,
      maxMemoryGiB: workspace.memoryCeilingGiB,
      workspaceStorageGiB: workspace.workspaceStorageGiB,
      runtimeStorageGiB: workspace.runtimeStorageGiB,
    })),
    phaseDurations: { preflight: 1.4, toolchain: 0.8, hostIntegration: 0.6, workspaces: 416 },
  },
  progressEvents: completeEvents,
  bootstrapResult: {
    resumed: true,
    phase: "complete",
    requiresApproval: false,
    vmsStarted: true,
    message: "Sandbox bootstrap and deep verification completed; the previous running set was restored.",
  },
  error: null,
} satisfies OnboardingSource

const dependencyFailureSource = {
  ...runningSource,
  preflightChecks: passingPreflightChecks.map((check) => check.id === "runtime-microsandbox" ? {
    id: "runtime-microsandbox",
    title: "Bundled MicroSandbox runtime",
    status: "unavailable" as const,
    detail: "The bundled MicroSandbox runtime failed its integrity check.",
    remediation: "Reinstall this Silo build from a trusted package.",
  } : check),
  progressEvents: [],
  bootstrapState: {
    phase: "preflight",
    startedAt: 810129720,
    updatedAt: 810129720,
    lastError: "Setup cannot continue until required preflight checks pass.",
    completedPhases: ["welcome"],
    phaseDurations: { preflight: 1.4 },
  },
} satisfies OnboardingSource

const bootstrapFailureMessage = "Candidate networking could not become ready for 'playgrounds'."
const bootstrapFailureSource = {
  ...runningSource,
  progressEvents: [
    ...configuredEvents(bootstrapConfiguration),
    ...bootstrapConfiguration.workspaces.slice(0, 1).flatMap(({ name }) => [
      progress(`Starting candidate networking for '${name}'.`, "workspace-networking", name, 0),
      progress(`Candidate networking is ready for '${name}'.`, "workspace-networking", name, 1),
    ]),
    progress("Starting candidate networking for 'playgrounds'.", "workspace-networking", "playgrounds", 0),
    progress("Candidate networking failed for 'playgrounds'.", "workspace-networking", "playgrounds", 0),
  ],
  bootstrapState: {
    ...runningSource.bootstrapState,
    lastError: bootstrapFailureMessage,
  },
  error: {
    code: "SILO_CANDIDATE_NETWORKING_FAILED",
    message: bootstrapFailureMessage,
    recovery: "Repair sandbox startup or SSH forwarding for 'playgrounds', then resume Setup.",
    workspace: "playgrounds",
    retryable: true,
  },
} satisfies OnboardingSource

// A separate, coherent fixture for long names, scrolling, and larger setup queues.
const stressRunningSource = {
  ...runningSource,
  machineConfigurations: stressBootstrapConfiguration.workspaces.map((workspace, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "vm" as const,
    name: workspace.name,
    cpus: workspace.cpu,
    maxCPUs: workspace.cpuCeiling,
    memoryGiB: workspace.memoryGiB,
    maxMemoryGiB: workspace.memoryCeilingGiB,
    workspaceStorageGiB: workspace.workspaceStorageGiB,
    runtimeStorageGiB: workspace.runtimeStorageGiB,
  })),
  bootstrapConfiguration: stressBootstrapConfiguration,
  progressEvents: verifyingEvents(stressBootstrapConfiguration, 3),
} satisfies OnboardingSource

export const onboardingScenarios: Record<ScenarioName, OnboardingSource> = {
  running: parseOnboardingSource(runningSource),
  complete: parseOnboardingSource(completeSource),
  "dependency-failure": parseOnboardingSource(dependencyFailureSource),
  "bootstrap-failure": parseOnboardingSource(bootstrapFailureSource),
  "stress-running": parseOnboardingSource(stressRunningSource),
}

export function scenarioFromSearch(search: string, fallback: ScenarioName = "running"): ScenarioName {
  const requested = new URLSearchParams(search).get("scenario")
  return scenarioNames.find((name) => name === requested) ?? fallback
}

export function githubStateFromSearch(search: string): GitHubFixtureState | undefined {
  const requested = new URLSearchParams(search).get("github")
  return githubFixtureStates.find((state) => state === requested)
}
