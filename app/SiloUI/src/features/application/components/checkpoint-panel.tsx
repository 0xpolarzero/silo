import { useState } from "react"
import { InlineConfirmation } from "@/components/inline-confirmation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { ApplicationActions, ApplicationWorkspace } from "@/features/application/model/application-source"
import type { WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"

type Choice = { action: "fork" | "restore"; checkpointId: string }
export function CheckpointPanel({ workspace, target, actions, disabled, onExport, exportDisabled = false }: {
  workspace: ApplicationWorkspace
  target: string
  actions: ApplicationActions
  disabled: boolean
  onExport?: (checkpoint: WorkspaceCheckpoint) => void
  exportDisabled?: boolean
}) {
  const [name, setName] = useState("")
  const [forkName, setForkName] = useState("")
  const [choice, setChoice] = useState<Choice | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkpoints = workspace.checkpoints ?? []
  const operation = workspace.checkpointOperation
  const busy = pending || operation?.status === "running"
  const locked = disabled || busy
  async function perform(action: () => Promise<void>, kind: "create" | "fork" | "restore") {
    if (locked) return
    setPending(true)
    setError(null)
    try {
      await action()
      setChoice(null)
      if (kind === "create") setName("")
      if (kind === "fork") setForkName("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return <section aria-label={`Checkpoints for ${workspace.machine.name}`} aria-busy={busy || undefined} className="border-t border-border p-3 text-xs">
    <div>
      <h3 className="font-medium">Checkpoints</h3>
      <p className="mt-0.5 text-muted-foreground">Save this sandbox’s current session and disks. Forks start stopped.</p>
    </div>
    <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); const title = name.trim(); if (!locked && title && actions.createCheckpoint) void perform(() => actions.createCheckpoint!(target, title), "create") }}>
      <Input aria-label="Checkpoint name" className="h-7 flex-1 text-xs" maxLength={80} value={choice ? "" : name} disabled={locked || Boolean(choice) || !actions.createCheckpoint} placeholder="Checkpoint name" onChange={event => setName(event.target.value)} />
      <Button type="submit" size="xs" disabled={locked || Boolean(choice) || !name.trim() || !actions.createCheckpoint}>Create</Button>
    </form>
    {checkpoints.length === 0 ? <p className="mt-3 text-muted-foreground">No checkpoints yet.</p> : <ol className="mt-3 divide-y divide-border border-t border-border" aria-label="Checkpoint history">
      {[...checkpoints].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <p className="truncate font-medium" title={item.name}>{item.name}</p>
          <p className="text-[11px] text-muted-foreground">{item.reason === "before-restore" ? "Recovery" : "Manual"} · {item.scope === "full" ? "Session and disks" : "Disks"} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></p>
        </div>
        <div className="flex items-center gap-1">
          {choice?.action === "restore" && choice.checkpointId === item.id ? <InlineConfirmation active onDismiss={() => { setChoice(null); setError(null) }}>
            <Button size="xs" variant="ghost" disabled={locked} onClick={() => { setChoice(null); setError(null) }}>Cancel</Button>
            <Button size="xs" disabled={locked || !actions.restoreCheckpoint} onClick={() => { if (actions.restoreCheckpoint) void perform(() => actions.restoreCheckpoint!(target, item.id), "restore") }}>Confirm restore</Button>
          </InlineConfirmation> : <>
            <Popover open={choice?.action === "fork" && choice.checkpointId === item.id} onOpenChange={open => { if (!open && choice?.action === "fork" && choice.checkpointId === item.id) setChoice(null) }}>
              <PopoverTrigger asChild>
                <Button size="xs" variant="ghost" disabled={locked || !actions.forkCheckpoint} onClick={() => { setChoice({ action: "fork", checkpointId: item.id }); setError(null) }}>Fork</Button>
              </PopoverTrigger>
              {choice?.action === "fork" && choice.checkpointId === item.id && <ForkPopover name={forkName} setName={setForkName} busy={locked} onCancel={() => { setChoice(null); setForkName("") }} onCreate={() => {
                const title = forkName.trim()
                if (locked || !title || !actions.forkCheckpoint) return
                setChoice(null)
                void perform(() => actions.forkCheckpoint!(target, item.id, title), "fork")
              }} />}
            </Popover>
            <TooltipProvider delayDuration={250}>
              <Tooltip><TooltipTrigger asChild><Button size="xs" variant="ghost" disabled={locked || !actions.restoreCheckpoint} onClick={() => { setChoice({ action: "restore", checkpointId: item.id }); setError(null) }}>Restore</Button></TooltipTrigger>
                <TooltipContent>Save a recovery checkpoint, then restore this state. The sandbox stays stopped.</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {!workspace.computer && onExport && <Button size="xs" variant="ghost" disabled={locked || exportDisabled} onClick={() => onExport(item)}>Export</Button>}
          </>}
        </div>
      </li>)}
    </ol>}
    {operation?.status === "failed" && !pending && (operation.error ?? operation.stage) !== error && <p role="alert" className="mt-2 text-destructive">{operation.error ?? operation.stage}</p>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    {!actions.createCheckpoint && <p className="mt-2 text-muted-foreground">Checkpoint operations are unavailable in this build.</p>}
  </section>
}

function ForkPopover({ name, setName, busy, onCancel, onCreate }: {
  name: string
  setName: (value: string) => void
  busy: boolean
  onCancel: () => void
  onCreate: () => void
}) {
  return <PopoverContent align="end" aria-label="Create stopped fork" className="w-64 p-3 text-xs">
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) onCreate() }}>
      <p className="font-medium">Create stopped fork</p>
      <p className="text-muted-foreground">Creates a stopped sandbox. Select Start when ready.</p>
      <Input aria-label="Fork name" className="h-7 text-xs" maxLength={32} value={name} disabled={busy} placeholder="New sandbox name" onChange={event => setName(event.target.value)} />
      <div className="flex justify-end gap-1"><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" size="xs" disabled={busy || !name.trim()}>Create fork</Button></div>
    </form>
  </PopoverContent>
}
