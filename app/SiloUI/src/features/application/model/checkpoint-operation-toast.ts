import { errorMessage, showOperationFailure, showOperationProgress, showOperationSuccess, type OperationStep } from "@/lib/operation-toast"
import { workspaceTarget } from "./remote-computers"
import { CHECKPOINT_CAPTURE_LABEL, type OperationQueue } from "./operation-queue"
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
  /** Sandbox name(s) the notification concerns, so it is dismissed if that sandbox is deleted. */
  sandbox?: string | string[]
  title: string
  run: () => Promise<void>
  success: { title: string; description?: string; action?: { label: string; onClick: () => void } }
  failureTitle: string
}

const active = new Map<string, { spec: CheckpointOperationSpec; startedAt: number }>()

/** Extra context for the running notification: the gate queue and how to cancel one of its entries. */
export interface CheckpointProgressContext {
  queue?: OperationQueue
  cancel?: (id: number) => void
}

const INITIAL_STEP: Record<CheckpointOperationSpec["kind"], string> = {
  capture: "Saving disk copies",
  restore: "Saving a recovery checkpoint",
  fork: "Copying from the checkpoint",
}

const RESTORE_STEPS = ["Save recovery checkpoint", "Restore disks", "Verify"]

/** Backend stages for restore are "Creating recovery checkpoint" then "Replacing workspace generation". */
function restoreSteps(stage: string | undefined): OperationStep[] {
  const current = stage && /replac/i.test(stage) ? 1 : 0
  return RESTORE_STEPS.map((label, index) => ({ label, state: index < current ? "done" : index === current ? "current" : "pending" }))
}

function show(entry: { spec: CheckpointOperationSpec; startedAt: number }, stage?: string, context?: CheckpointProgressContext, vmId?: string) {
  const { spec, startedAt } = entry
  // The queue toast hides checkpoint capture, so this notification carries its Cancel.
  const capture = spec.kind === "capture" && context?.cancel && context.queue && vmId
    ? context.queue.running.find(item => item.label === CHECKPOINT_CAPTURE_LABEL && item.cancellable && item.vmId === vmId)
    : undefined
  showOperationProgress(spec.id, {
    title: spec.title,
    step: stage ?? INITIAL_STEP[spec.kind],
    steps: spec.kind === "restore" ? restoreSteps(stage) : undefined,
    startedAt,
    sandbox: spec.sandbox,
    cancel: capture && context?.cancel ? { onCancel: () => context.cancel!(capture.id) } : undefined,
  })
}

export async function runCheckpointOperation(spec: CheckpointOperationSpec): Promise<boolean> {
  const entry = { spec, startedAt: Date.now() }
  active.set(spec.id, entry)
  show(entry)
  try {
    await spec.run()
    active.delete(spec.id)
    showOperationSuccess(spec.id, spec.success.title, { description: spec.success.description, action: spec.success.action, sandbox: spec.sandbox })
    return true
  } catch (cause) {
    active.delete(spec.id)
    showOperationFailure(spec.id, spec.failureTitle, { description: errorMessage(cause), retry: () => { void runCheckpointOperation(spec) }, sandbox: spec.sandbox })
    return false
  }
}

/** Refine running notifications with the backend's stage. Call whenever workspaces or the queue change. */
export function syncCheckpointProgress(workspaces: ApplicationWorkspace[], context?: CheckpointProgressContext) {
  if (active.size === 0) return
  for (const entry of active.values()) {
    const workspace = workspaces.find(candidate => workspaceTarget(candidate) === entry.spec.target)
    const operation = workspace?.checkpointOperation
    if (operation?.status === "running" && operation.kind === entry.spec.kind) show(entry, operation.stage, context, workspace && !workspace.computer ? workspace.machine.id : undefined)
  }
}
