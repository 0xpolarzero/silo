import { useState } from "react"
import { Dialog } from "radix-ui"
import { History, Loader2, ShieldCheck } from "lucide-react"
import { ActionsMenu } from "@/components/actions-menu"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { TooltipProvider } from "@/components/ui/tooltip"
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/relative-time"
import { ForkStateDialog } from "./fork-state-dialog"
import type { ApplicationActions, ApplicationWorkspace } from "@/features/application/model/application-source"
import type { WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"

function suggestedName(now = new Date()) {
  return `Checkpoint ${now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
}

function checkpointTag(checkpoint: WorkspaceCheckpoint) {
  if (checkpoint.reason === "before-restore") return "Recovery"
  return checkpoint.scope === "full" ? "Includes memory" : "Disks only"
}

export function CheckpointPanel({ workspace, target, actions, disabled, onExport, exportDisabled = false, onForked, onRestored }: {
  workspace: ApplicationWorkspace
  target: string
  actions: ApplicationActions
  disabled: boolean
  onExport?: (checkpoint: WorkspaceCheckpoint) => void
  exportDisabled?: boolean
  /** Called with the new sandbox name after a fork resolves, so the caller can toast it. */
  onForked?: (name: string) => void
  /** Called with the restored checkpoint after a restore resolves, so the caller can toast it. */
  onRestored?: (checkpoint: WorkspaceCheckpoint) => void
}) {
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState(suggestedName)
  const [forkCheckpoint, setForkCheckpoint] = useState<WorkspaceCheckpoint | null>(null)
  const [restoreCheckpoint, setRestoreCheckpoint] = useState<WorkspaceCheckpoint | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkpoints = [...(workspace.checkpoints ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const operation = workspace.checkpointOperation
  const running = operation?.status === "running"
  const busy = pending || running
  const locked = disabled || busy
  const isLocal = !workspace.computer

  async function create() {
    const title = name.trim()
    if (locked || !title || !actions.createCheckpoint) return
    setPending(true)
    setError(null)
    try {
      await actions.createCheckpoint(target, title)
      setCreateOpen(false)
      setName(suggestedName())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  async function restore() {
    const checkpoint = restoreCheckpoint
    if (locked || !checkpoint || !actions.restoreCheckpoint) return
    setPending(true)
    setError(null)
    try {
      await actions.restoreCheckpoint(target, checkpoint.id)
      setRestoreCheckpoint(null)
      onRestored?.(checkpoint)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const operationError = operation?.status === "failed" ? operation.error ?? operation.stage : null

  return <TooltipProvider delayDuration={250}>
    <section aria-label={`Checkpoints for ${workspace.machine.name}`} aria-busy={busy || undefined} className="grid gap-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground">Saved states of this sandbox. Restore rewinds it; Fork creates a new stopped sandbox.</p>
        {actions.createCheckpoint && <Popover open={createOpen} onOpenChange={open => { if (!locked) { setCreateOpen(open); if (open) { setName(suggestedName()); setError(null) } } }}>
          <PopoverTrigger asChild>
            <Button size="xs" variant="outline" className="shrink-0" disabled={locked}>New checkpoint</Button>
          </PopoverTrigger>
          <PopoverContent align="end" aria-label="New checkpoint" className="w-72 p-3 text-xs">
            <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void create() }}>
              <p className="font-medium">New checkpoint</p>
              <Input aria-label="Checkpoint name" className="h-7 text-xs" maxLength={80} autoFocus value={name} disabled={locked} placeholder="Checkpoint name" onChange={event => setName(event.target.value)} />
              <div className="flex justify-end gap-1">
                <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button type="submit" size="xs" disabled={locked || !name.trim()}>Create</Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>}
      </div>

      {running && operation && <div role="status" aria-live="polite" aria-atomic="true" className="grid gap-1.5">
        <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />{operation.stage}</p>
        <Progress value={null} aria-label="Checkpoint operation progress" />
      </div>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {operationError && !pending && operationError !== error && <p role="alert" className="text-destructive">{operationError}</p>}

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
                <Button size="xs" variant="outline" disabled={locked || !actions.restoreCheckpoint} onClick={() => { setError(null); setRestoreCheckpoint(checkpoint) }}>Restore</Button>
                <ActionsMenu label={`Checkpoint actions for ${checkpoint.name}`} disabled={locked} items={[
                  ...(actions.forkCheckpoint ? [{ label: "Fork…", accessibleLabel: `Fork ${checkpoint.name}`, disabled: locked, onSelect: () => { setError(null); setForkCheckpoint(checkpoint) } }] : []),
                  ...(isLocal && onExport ? [{ label: "Export…", accessibleLabel: `Export ${checkpoint.name}`, disabled: locked || exportDisabled, onSelect: () => onExport(checkpoint) }] : []),
                ]} />
              </div>}
            />
          })}
        </ListCard>
      )}

      {!actions.createCheckpoint && <p className="text-muted-foreground">Checkpoint operations are unavailable in this build.</p>}

      {forkCheckpoint && actions.forkCheckpoint && <ForkStateDialog
        key={forkCheckpoint.id}
        sandboxName={workspace.machine.name}
        title={`Fork from “${forkCheckpoint.name}”`}
        description="Creates a new stopped sandbox from this checkpoint. Select Start when ready."
        disabled={disabled || running}
        progressStage={running ? operation?.stage : undefined}
        fork={async newName => { await actions.forkCheckpoint!(target, forkCheckpoint.id, newName); onForked?.(newName) }}
        onClose={() => setForkCheckpoint(null)}
      />}

      {restoreCheckpoint && <Dialog.Root open onOpenChange={open => { if (!open && !busy) setRestoreCheckpoint(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none">
            <Dialog.Title className="text-sm font-medium">Restore “{restoreCheckpoint.name}”</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted-foreground">Silo saves a recovery checkpoint first, then rewinds {workspace.machine.name}. The sandbox stays stopped.</Dialog.Description>
            {busy && <div className="mt-3 grid gap-1.5" role="status" aria-live="polite"><p className="text-xs text-muted-foreground">{running ? operation?.stage : "Restoring…"}</p><Progress value={null} aria-label="Restore progress" /></div>}
            {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setRestoreCheckpoint(null)}>Cancel</Button>
              <Button type="button" size="sm" disabled={locked || !actions.restoreCheckpoint} onClick={() => void restore()}>Restore</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>}
    </section>
  </TooltipProvider>
}
