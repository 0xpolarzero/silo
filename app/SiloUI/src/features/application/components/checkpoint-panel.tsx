import { useState } from "react"
import { History, ShieldCheck } from "lucide-react"
import { ActionsMenu } from "@/components/actions-menu"
import { ConfirmPopover, FormPopover } from "@/components/confirm-popover"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TooltipProvider } from "@/components/ui/tooltip"
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/relative-time"
import { runCheckpointOperation } from "@/features/application/model/checkpoint-operation-toast"
import { ForkBody } from "./fork-popover"
import type { ApplicationActions, ApplicationWorkspace } from "@/features/application/model/application-source"
import type { WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"

function suggestedName(now = new Date()) {
  // Always English: the UI copy is English, so the system locale must not leak month names.
  return `Checkpoint ${now.toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
}

function checkpointTag(checkpoint: WorkspaceCheckpoint) {
  if (checkpoint.reason === "before-restore") return "Recovery"
  return checkpoint.scope === "full" ? "Includes memory" : "Disks only"
}

export function CheckpointPanel({ workspace, target, actions, disabled, onExport, exportDisabled = false, forkedAction, restoredAction }: {
  workspace: ApplicationWorkspace
  target: string
  actions: ApplicationActions
  disabled: boolean
  onExport?: (checkpoint: WorkspaceCheckpoint) => void
  exportDisabled?: boolean
  /** Action on the "Fork created" notification, e.g. Open. Receives the new sandbox name. */
  forkedAction?: (name: string) => { label: string; onClick: () => void }
  /** Action on the "Restored" notification, e.g. Start. */
  restoredAction?: (checkpoint: WorkspaceCheckpoint) => { label: string; onClick: () => void }
}) {
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState(suggestedName)
  const [pending, setPending] = useState(false)
  /** True once the user started an operation here, so its outcome is reported by a notification rather than an inline label. */
  const [started, setStarted] = useState(false)
  const checkpoints = [...(workspace.checkpoints ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const operation = workspace.checkpointOperation
  const running = operation?.status === "running"
  const busy = pending || running
  const locked = disabled || busy
  const isLocal = !workspace.computer
  const sandbox = workspace.machine.name
  const noticeSandbox = { id: workspace.machine.id, name: sandbox }

  async function run(spec: Parameters<typeof runCheckpointOperation>[0]) {
    setPending(true)
    setStarted(true)
    try { return await runCheckpointOperation(spec) } finally { setPending(false) }
  }

  function create() {
    const title = name.trim()
    if (locked || !title || !actions.createCheckpoint) return
    void run({
      id: `checkpoint:${target}:capture`,
      kind: "capture",
      target,
      sandbox,
      noticeSandbox,
      title: `Creating checkpoint “${title}”`,
      run: () => actions.createCheckpoint!(target, title),
      success: { title: "Checkpoint created", description: title },
      failureTitle: `Could not create checkpoint “${title}”`,
    }).then(ok => { if (ok) setName(suggestedName()) })
  }

  function restore(checkpoint: WorkspaceCheckpoint) {
    if (locked || !actions.restoreCheckpoint) return
    void run({
      id: `checkpoint:${target}:restore`,
      kind: "restore",
      target,
      sandbox,
      noticeSandbox,
      title: `Restoring “${checkpoint.name}”`,
      run: () => actions.restoreCheckpoint!(target, checkpoint.id),
      success: { title: `Restored “${checkpoint.name}”`, description: `${sandbox} is stopped. A recovery checkpoint was saved first.`, action: restoredAction?.(checkpoint) },
      failureTitle: `Could not restore “${checkpoint.name}”`,
    })
  }

  function fork(checkpoint: WorkspaceCheckpoint, newName: string) {
    if (locked || !actions.forkCheckpoint) return
    void run({
      id: `checkpoint:${target}:fork`,
      kind: "fork",
      target,
      sandbox: [sandbox, newName],
      noticeSandbox,
      title: `Creating fork ${newName}`,
      run: () => actions.forkCheckpoint!(target, checkpoint.id, newName),
      success: { title: "Fork created", description: `${newName} is stopped. Start it when you’re ready.`, action: forkedAction?.(newName) },
      failureTitle: `Could not create fork ${newName}`,
    })
  }

  // A failure that predates this session is only noted quietly; failures of operations started here are notified.
  const staleFailure = operation?.status === "failed" && !started ? operation.error ?? operation.stage : null

  return <TooltipProvider delayDuration={250}>
    <section aria-label={`Checkpoints for ${workspace.machine.name}`} aria-busy={busy || undefined} className="grid gap-1.5 text-xs">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium" title="Saved states of this sandbox. Restore rewinds it; Fork creates a new stopped sandbox.">Checkpoints</h3>
        {actions.createCheckpoint && <FormPopover
          open={createOpen}
          onOpenChange={open => { if (!open || !locked) { setCreateOpen(open); if (open) setName(suggestedName()) } }}
          align="end"
          title="New checkpoint"
          confirmLabel="Create"
          canSubmit={!locked && name.trim().length > 0}
          onSubmit={create}
          fields={<Input aria-label="Checkpoint name" className="h-7 text-xs" maxLength={80} value={name} placeholder="Checkpoint name" onChange={event => setName(event.target.value)} />}
        >
          <Button size="xs" variant="outline" className="shrink-0" disabled={locked}>New checkpoint</Button>
        </FormPopover>}
      </div>

      {staleFailure && <p className="text-muted-foreground">Last checkpoint operation failed: <span className="text-destructive">{staleFailure}</span></p>}

      {checkpoints.length === 0 ? (
        <ListCard>
          <ListRow
            icon={<ListRowIcon aria-hidden="true"><History className="size-3.5" /></ListRowIcon>}
            title="No checkpoints yet"
            detail="Save a checkpoint to rewind or fork this sandbox later."
            detailClassName="whitespace-normal"
          />
        </ListCard>
      ) : (
        <ListCard divided aria-label="Checkpoint history">
          {checkpoints.map(checkpoint => {
            const Icon = checkpoint.reason === "before-restore" ? ShieldCheck : History
            return <ListRow
              key={checkpoint.id}
              data-checkpoint-name={checkpoint.name}
              icon={<ListRowIcon aria-hidden="true"><Icon className="size-3.5" /></ListRowIcon>}
              title={<span className="truncate" title={checkpoint.name}>{checkpoint.name}</span>}
              detail={<>
                <time dateTime={checkpoint.createdAt} title={formatAbsoluteTime(checkpoint.createdAt)}>{formatRelativeTime(checkpoint.createdAt) || formatAbsoluteTime(checkpoint.createdAt)}</time>
                {" · "}{checkpointTag(checkpoint)}
              </>}
              actions={<div className="flex shrink-0 items-center gap-1">
                <ConfirmPopover
                  align="end"
                  title={`Restore “${checkpoint.name}”?`}
                  description={`Silo saves a recovery checkpoint first, then rewinds ${sandbox}. It stays stopped.`}
                  confirmLabel="Restore"
                  onConfirm={() => restore(checkpoint)}
                >
                  <Button size="xs" variant="outline" disabled={locked || !actions.restoreCheckpoint}>Restore</Button>
                </ConfirmPopover>
                <ActionsMenu
                  label={`Checkpoint actions for ${checkpoint.name}`}
                  disabled={locked}
                  popovers={{ fork: close => <ForkBody sandboxName={sandbox} title={`Fork from “${checkpoint.name}”`} description="Creates a new stopped sandbox from this checkpoint. Select Start when ready." disabled={locked} onFork={newName => fork(checkpoint, newName)} onClose={close} /> }}
                  items={[
                    ...(actions.forkCheckpoint ? [{ label: "Fork…", accessibleLabel: `Fork ${checkpoint.name}`, disabled: locked, popover: "fork" }] : []),
                    ...(isLocal && onExport ? [{ label: "Export…", accessibleLabel: `Export ${checkpoint.name}`, disabled: locked || exportDisabled, onSelect: () => onExport(checkpoint) }] : []),
                  ]}
                />
              </div>}
            />
          })}
        </ListCard>
      )}

      {!actions.createCheckpoint && <p className="text-muted-foreground">Checkpoint operations are unavailable in this build.</p>}

    </section>
  </TooltipProvider>
}
