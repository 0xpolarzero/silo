import { errorMessage, showOperationFailure, showOperationProgress, showOperationSuccess, type OperationStep } from "@/lib/operation-toast"
import { workspaceTarget } from "./remote-computers"
import type { ApplicationWorkspace } from "./application-source"
import type { WorkspaceCheckpointOperation } from "./checkpoint-source"

/**
 * One progress notification per checkpoint operation (create, fork, restore): the popover that
 * asked closes at once, the work continues here under a stable id, and the same toast turns into
 * the success (stays until closed) or failure (stays, with Retry) message.
 */
export interface CheckpointOperationSpec {
  id: string
  kind: WorkspaceCheckpointOperation["kind"]
  /** The sandbox the backend reports the operation on (`workspaceTarget`). */
  target: string
  title: string
  run: () => Promise<void>
  success: { title: string; description?: string; action?: { label: string; onClick: () => void } }
  failureTitle: string
}

const active = new Map<string, { spec: CheckpointOperationSpec; startedAt: number }>()

const RESTORE_STEPS = ["Save recovery checkpoint", "Restore disks", "Verify"]

/** Backend stages for restore are "Creating recovery checkpoint" then "Replacing workspace generation". */
function restoreSteps(stage: string | undefined): OperationStep[] {
  const current = stage && /replac/i.test(stage) ? 1 : 0
  return RESTORE_STEPS.map((label, index) => ({ label, state: index < current ? "done" : index === current ? "current" : "pending" }))
}

function show(entry: { spec: CheckpointOperationSpec; startedAt: number }, stage?: string) {
  const { spec, startedAt } = entry
  showOperationProgress(spec.id, {
    title: spec.title,
    step: stage ?? "Starting…",
    steps: spec.kind === "restore" ? restoreSteps(stage) : undefined,
    startedAt,
  })
}

export async function runCheckpointOperation(spec: CheckpointOperationSpec): Promise<boolean> {
  const entry = { spec, startedAt: Date.now() }
  active.set(spec.id, entry)
  show(entry)
  try {
    await spec.run()
    active.delete(spec.id)
    showOperationSuccess(spec.id, spec.success.title, { description: spec.success.description, action: spec.success.action })
    return true
  } catch (cause) {
    active.delete(spec.id)
    showOperationFailure(spec.id, spec.failureTitle, { description: errorMessage(cause), retry: () => { void runCheckpointOperation(spec) } })
    return false
  }
}

/** Refine running notifications with the backend's stage. Call whenever workspaces change. */
export function syncCheckpointProgress(workspaces: ApplicationWorkspace[]) {
  if (active.size === 0) return
  for (const entry of active.values()) {
    const operation = workspaces.find(workspace => workspaceTarget(workspace) === entry.spec.target)?.checkpointOperation
    if (operation?.status === "running" && operation.kind === entry.spec.kind) show(entry, operation.stage)
  }
}
