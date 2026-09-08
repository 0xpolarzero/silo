import type {
  SetupQueueItemID,
  SiloPreflightCheck,
  SiloProgressEvent,
} from "@/contracts/silo"
import type { GitHubConnectionState, OnboardingSource } from "@/features/onboarding/model/onboarding-source"

export const onboardingSteps = ["dependencies", "workspaces", "github", "review"] as const
export type OnboardingStep = (typeof onboardingSteps)[number]

export type PresentationStatus = "waiting" | "running" | "succeeded" | "failed"

export interface DependencyItemView {
  name: string
  check?: SiloPreflightCheck
}

export interface DependencyGroupView {
  id: string
  title: string
  status: "succeeded" | "failed" | "running"
  items: DependencyItemView[]
}

export interface WorkspaceView {
  name: string
  status: "waiting" | "working" | "ready" | "failed"
  detail: string
}

export interface WorkspaceProgressView {
  status: PresentationStatus
  elapsedSeconds: number
  currentWorkspace?: string
  currentMessage: string
  completedOperations: number
  totalOperations: number
  fraction?: number
  workspaces: WorkspaceView[]
  visibleEvents: SiloProgressEvent[]
  readyCount: number
  workingCount: number
  waitingCount: number
  failedCount: number
  recovery?: string
  retryable: boolean
}

export interface ReviewQueueItemView {
  id: SetupQueueItemID
  label: string
  status: "queued" | "running" | "succeeded" | "failed"
  failure?: string
}

export interface OnboardingViewModel {
  dependencies: DependencyGroupView[]
  dependencyStatus: PresentationStatus
  workspaceProgress: WorkspaceProgressView
  queueItems: ReviewQueueItemView[]
  finishEnabled: boolean
  error: OnboardingSource["error"]
  stepStatus: Record<OnboardingStep, PresentationStatus>
}

const inventory = [
  {
    id: "system",
    title: "System",
    items: [
      ["Supported OS", "system-os"],
      ["Virtualization", "system-virtualization"],
    ],
  },
  {
    id: "bundled-tools",
    title: "Bundled tools",
    items: [
      ["MicroSandbox runtime", "runtime-microsandbox"],
      ["Git", "tool-git"],
      ["Git LFS", "tool-git-lfs"],
    ],
  },
] as const

const queueByStep: Record<"workspaces" | "review", SetupQueueItemID[]> = {
  workspaces: ["workspaceRun", "workspaceVerify"],
  review: ["completion"],
}

const workspaceOperationSteps = new Set([
  "workspace-configuration",
  "workspace-networking",
  "workspace-verification",
])

function combineQueueStatus(items: ReviewQueueItemView[]): PresentationStatus {
  if (items.some(({ status }) => status === "failed")) return "failed"
  if (items.some(({ status }) => status === "running")) return "running"
  if (items.length > 0 && items.every(({ status }) => status === "succeeded")) return "succeeded"
  return "waiting"
}

function workspaceDetail(event: SiloProgressEvent): string {
  if (event.fraction === 1 && event.step === "workspace-verification") return "Ready"
  return event.message
}

const queueLabels: Record<SetupQueueItemID, string> = {
  workspaceRun: "Create sandboxes",
  workspaceVerify: "Verify sandboxes",
  githubRun: "Save GitHub",
  githubVerify: "Verify GitHub",
  identityRun: "Save Git identities",
  identityVerify: "Verify Git identities",
  completion: "Finish setup",
}

function projectQueue(source: OnboardingSource): ReviewQueueItemView[] {
  const ids = Object.keys(queueLabels) as SetupQueueItemID[]
  const completedPhases = new Set(source.bootstrapState.completedPhases)
  const workspaceBoundaryComplete = completedPhases.has("workspaces") && source.bootstrapResult?.phase === "complete"
  const allSetupComplete = completedPhases.has("complete") && workspaceBoundaryComplete && !source.error
  const isVerifying = source.progressEvents.some(({ step }) => step === "workspace-verification")
  return ids.map((id) => {
    if (allSetupComplete) return { id, label: queueLabels[id], status: "succeeded" }
    if (workspaceBoundaryComplete && (id === "workspaceRun" || id === "workspaceVerify")) {
      return { id, label: queueLabels[id], status: "succeeded" }
    }
    if (completedPhases.has("github") && (id === "githubRun" || id === "githubVerify")) {
      return { id, label: queueLabels[id], status: "succeeded" }
    }
    if (completedPhases.has("identity") && (id === "identityRun" || id === "identityVerify")) {
      return { id, label: queueLabels[id], status: "succeeded" }
    }
    if (source.error && id === (isVerifying ? "workspaceVerify" : "workspaceRun")) {
      return { id, label: queueLabels[id], status: "failed", failure: source.error.message }
    }
    if (source.progressEvents.length > 0) {
      if (id === "workspaceRun") return { id, label: queueLabels[id], status: isVerifying ? "succeeded" : "running" }
      if (id === "workspaceVerify" && isVerifying && !source.error) return { id, label: queueLabels[id], status: "running" }
    }
    return { id, label: queueLabels[id], status: "queued" }
  })
}

function projectWorkspaceProgress(source: OnboardingSource, queueItems: ReviewQueueItemView[]): WorkspaceProgressView {
  const activeRevision = source.progressEvents.findLast(({ revision }) => revision !== undefined)?.revision
  const activeEvents = source.progressEvents.filter((event) => (
    !activeRevision || !event.revision || event.revision === activeRevision
  ))
  const visibleEvents = activeEvents.filter(({ safeForDisplay }) => safeForDisplay)
  const completionKeys = new Set(
    activeEvents
      .filter((event) => event.workspace && event.step && workspaceOperationSteps.has(event.step) && event.fraction === 1)
      .map((event) => `${event.workspace}:${event.step}`),
  )
  const currentEvent = visibleEvents.at(-1)
  const failedWorkspace = source.error?.workspace ?? undefined
  const latestByWorkspace = new Map<string, SiloProgressEvent>()
  for (const event of activeEvents) {
    if (event.workspace) latestByWorkspace.set(event.workspace, event)
  }

  const workspaceVerified = source.bootstrapState.completedPhases.includes("workspaces") && source.bootstrapResult?.phase === "complete"
  const workspaces = source.bootstrapConfiguration.workspaces.map(({ name }): WorkspaceView => {
    const latest = latestByWorkspace.get(name)
    if (failedWorkspace === name) {
      return { name, status: "failed", detail: source.error?.message ?? "Setup failed" }
    }
    if (workspaceVerified || (latest?.step === "workspace-verification" && latest.fraction === 1)) {
      return { name, status: "ready", detail: "Ready" }
    }
    if (latest && latest === currentEvent && latest.fraction !== 1) {
      return { name, status: "working", detail: workspaceDetail(latest) }
    }
    if (latest?.step === "workspace-networking" && latest.fraction === 1) {
      return { name, status: "waiting", detail: "Waiting for verification" }
    }
    if (latest?.step === "workspace-configuration" && latest.fraction === 1) {
      return { name, status: "waiting", detail: "Waiting for networking" }
    }
    if (latest) return { name, status: "waiting", detail: "Waiting" }
    return { name, status: "waiting", detail: "Waiting" }
  })

  const queueStatus = combineQueueStatus(queueItems.filter(({ id }) => queueByStep.workspaces.includes(id)))
  const recordedProgress = activeEvents.some(({ step }) => step && workspaceOperationSteps.has(step))
  const totalOperations = workspaces.length * (recordedProgress ? 3 : 2)
  const completedOperations = recordedProgress ? completionKeys.size : queueItems.filter(({ id, status }) => queueByStep.workspaces.includes(id) && status === "succeeded").length * workspaces.length
  return {
    status: queueStatus,
    elapsedSeconds: source.bootstrapState.startedAt
      ? Math.max(0, source.bootstrapState.updatedAt - source.bootstrapState.startedAt)
      : 0,
    currentWorkspace: currentEvent?.workspace,
    currentMessage: source.error?.message ?? currentEvent?.message ?? source.bootstrapResult?.message ?? "Waiting to create workspaces",
    completedOperations,
    totalOperations,
    fraction: totalOperations > 0 ? completedOperations / totalOperations : undefined,
    workspaces,
    visibleEvents,
    readyCount: workspaces.filter(({ status }) => status === "ready").length,
    workingCount: workspaces.filter(({ status }) => status === "working").length,
    waitingCount: workspaces.filter(({ status }) => status === "waiting").length,
    failedCount: workspaces.filter(({ status }) => status === "failed").length,
    recovery: source.error?.recovery ?? undefined,
    retryable: source.error?.retryable ?? false,
  }
}

export function projectOnboarding(source: OnboardingSource, githubConnectionState: GitHubConnectionState): OnboardingViewModel {
  const checksById = new Map(source.preflightChecks.map((check) => [check.id, check]))
  const dependencies = inventory.map((group): DependencyGroupView => {
    const items = group.items.map(([name, checkId]) => {
      const check = checksById.get(checkId) ?? {
        id: checkId,
        title: name,
        status: "unavailable" as const,
        detail: "No check result was reported.",
        remediation: null,
      }
      return { name, check }
    })
    const status = items.some(({ check }) => check?.status === "pending")
      ? "running" as const
      : items.some(({ check }) => check && check.status !== "pass") ? "failed" as const : "succeeded" as const
    return {
      id: group.id,
      title: group.title,
      status,
      items,
    }
  })
  const dependencyStatus = dependencies.some(({ status }) => status === "running")
    ? "running"
    : dependencies.some(({ status }) => status === "failed") ? "failed" : "succeeded"
  const queueItems = projectQueue(source)
  const workspaceProgress = projectWorkspaceProgress(source, queueItems)
  const stepStatus = {
    dependencies: dependencyStatus,
    workspaces: workspaceProgress.status,
    github: githubConnectionState === "connected"
      ? "succeeded"
      : githubConnectionState === "connecting" ? "running" : "waiting",
    review: combineQueueStatus(queueItems.filter(({ id }) => queueByStep.review.includes(id))),
  } satisfies Record<OnboardingStep, PresentationStatus>

  return {
    dependencies,
    dependencyStatus,
    workspaceProgress,
    queueItems,
    finishEnabled: dependencyStatus === "succeeded" && source.error === null && (source.readyToFinish ?? queueItems.every(({ status }) => status === "succeeded")),
    error: source.error,
    stepStatus,
  }
}
