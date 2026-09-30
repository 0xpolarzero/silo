import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import { WorkspaceWaitingStatus } from "@/features/application/components/operation-queue-panel"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"
import { emptyOperationQueue, waitingOperationForVm } from "@/features/application/model/operation-queue"

type LifecycleAction = NonNullable<ApplicationWorkspace["lifecycleAction"]>

const lifecycleLabels: Record<LifecycleAction, string> = {
  start: "Starting…",
  stop: "Stopping…",
  restart: "Restarting…",
  "dismiss-error": "Dismissing…",
}

export const StatusSeparator = () => <span aria-hidden="true" className="mx-1">·</span>

/**
 * A sandbox's lifecycle-aware status, shared by its list row and its page: the state label,
 * or the pending action (or what it waits for in the operation queue), a remote computer's
 * refresh, or its offline state.
 */
export function WorkspaceStatus({ workspace, source, readOnly, onCancel }: { workspace: ApplicationWorkspace; source: ApplicationSource; readOnly: boolean; onCancel?: ApplicationActions["cancelOperation"] }) {
  const lifecycle = workspace.lifecycleAction
  // The operation gate keys local per-VM entries by the stable VM id. A remote computer's VMs
  // run on that computer's own gate, so a remote sandbox never matches a local entry.
  const queueVmId = workspace.computer ? null : workspace.machine.id
  const waitingForVm = queueVmId !== null ? waitingOperationForVm(source.operationQueue ?? emptyOperationQueue, queueVmId) : undefined
  const cancel = readOnly ? undefined : onCancel
  if (lifecycle) {
    // Until its queue entry runs, a pending action reads "Waiting for <blocker>…".
    return waitingForVm && queueVmId !== null
      ? <WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={cancel} />
      : <span role="status" className="text-amber-700 dark:text-amber-400">{lifecycleLabels[lifecycle]}</span>
  }
  if (workspace.accountMigration?.status === "running") {
    const { stage } = workspace.accountMigration
    return <span role="status" className="text-amber-700 dark:text-amber-400">Moving to the silo account{stage ? ` · ${stage}` : ""}…</span>
  }
  if (workspace.computer?.busy) return <span role="status">Updating…</span>
  if (workspace.computer && !workspace.computer.connected) return <span>Offline · last known status</span>
  return <span className="inline-flex items-center gap-1.5 align-middle">
    <WorkspaceStateLabel state={workspace.state} />
    {queueVmId !== null && waitingForVm && <><StatusSeparator /><WorkspaceWaitingStatus queue={source.operationQueue} vmId={queueVmId} onCancel={cancel} /></>}
  </span>
}
