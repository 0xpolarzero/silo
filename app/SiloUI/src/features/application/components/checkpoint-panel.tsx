import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ApplicationActions, ApplicationWorkspace } from "@/features/application/model/application-source"

type Choice = { action: "fork" | "restore"; checkpointId: string | null }

export function CheckpointPanel({ workspace, target, actions, disabled }: {
  workspace: ApplicationWorkspace
  target: string
  actions: ApplicationActions
  disabled: boolean
}) {
  const [name, setName] = useState("")
  const [choice, setChoice] = useState<Choice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkpoints = workspace.checkpoints ?? []
  const operation = workspace.checkpointOperation
  const locked = disabled || busy || operation?.status === "running"
  const selected = checkpoints.find(item => item.id === choice?.checkpointId)

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setChoice(null)
      setName("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <section aria-label={`Checkpoints for ${workspace.machine.name}`} className="mx-3 mb-2 rounded-md border border-border bg-background p-3 text-xs">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-medium">Checkpoints</h3>
        <p className="mt-0.5 text-muted-foreground">Save this sandbox’s current session and disks. Forks start stopped.</p>
      </div>
      <Button size="xs" variant="outline" disabled={locked || !actions.forkCheckpoint} onClick={() => { setChoice({ action: "fork", checkpointId: null }); setName(""); setError(null) }}>Fork current state</Button>
    </div>
    <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); const title = name.trim(); if (title && actions.createCheckpoint) void perform(() => actions.createCheckpoint!(target, title)) }}>
      <Input aria-label="Checkpoint name" className="h-7 flex-1 text-xs" maxLength={80} value={choice ? "" : name} disabled={locked || Boolean(choice) || !actions.createCheckpoint} placeholder="Checkpoint name" onChange={event => setName(event.target.value)} />
      <Button type="submit" size="xs" disabled={locked || Boolean(choice) || !name.trim() || !actions.createCheckpoint}>Create checkpoint</Button>
    </form>
    {checkpoints.length === 0 ? <p className="mt-3 text-muted-foreground">No checkpoints yet.</p> : <ol className="mt-3 divide-y rounded-md border" aria-label="Checkpoint history">
      {[...checkpoints].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
        <div className="min-w-0">
          <p className="truncate font-medium" title={item.name}>{item.name}</p>
          <p className="text-[11px] text-muted-foreground">{item.reason === "before-restore" ? "Recovery" : "Manual"} · {item.scope === "full" ? "Session and disks" : "Disks"} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></p>
        </div>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" disabled={locked || !actions.forkCheckpoint} onClick={() => { setChoice({ action: "fork", checkpointId: item.id }); setName(""); setError(null) }}>Fork</Button>
          <Button size="xs" variant="ghost" disabled={locked || !actions.restoreCheckpoint} onClick={() => { setChoice({ action: "restore", checkpointId: item.id }); setError(null) }}>Restore</Button>
        </div>
      </li>)}
    </ol>}
    {choice && <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[.05] p-2">
      {choice.action === "fork" ? <>
        <p className="font-medium">Create a stopped fork{selected ? ` from ${selected.name}` : " from current state"}</p>
        <p className="mt-1 text-muted-foreground">The fork inherits current credential assignments. Its first Start restores the captured state; creating it runs no guest programs.</p>
        <Input aria-label="Fork name" className="mt-2 h-7 text-xs" maxLength={32} value={name} disabled={locked} placeholder="New sandbox name" onChange={event => setName(event.target.value)} />
      </> : <>
        <p className="font-medium">Restore {selected?.name ?? "checkpoint"}?</p>
        <p className="mt-1 text-muted-foreground">Silo first saves a recovery checkpoint of the current state, then rewinds this sandbox. It remains stopped until you select Start. Current credential permissions stay in effect.</p>
      </>}
      <div className="mt-2 flex justify-end gap-1">
        <Button size="xs" variant="ghost" disabled={locked} onClick={() => { setChoice(null); setName(""); setError(null) }}>Cancel</Button>
        <Button size="xs" disabled={locked || (choice.action === "fork" ? !name.trim() || !actions.forkCheckpoint : !actions.restoreCheckpoint)} onClick={() => {
          if (choice.action === "fork" && actions.forkCheckpoint) void perform(() => actions.forkCheckpoint!(target, choice.checkpointId, name.trim()))
          if (choice.action === "restore" && choice.checkpointId && actions.restoreCheckpoint) void perform(() => actions.restoreCheckpoint!(target, choice.checkpointId!))
        }}>{choice.action === "fork" ? "Create stopped fork" : "Save recovery point and restore"}</Button>
      </div>
    </div>}
    {operation && <p role={operation.status === "failed" ? "alert" : "status"} className={`mt-2 ${operation.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{operation.status === "failed" ? operation.error ?? operation.stage : operation.stage}</p>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    {!actions.createCheckpoint && <p className="mt-2 text-muted-foreground">Checkpoint operations are unavailable in this build.</p>}
  </section>
}
