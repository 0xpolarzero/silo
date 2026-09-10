import { useEffect, useState } from "react"
import { Archive, Check, Circle, CircleX, RotateCcw, TriangleAlert } from "lucide-react"

import { DisclosureHeader } from "@/components/disclosure-header"
import { ListCard, ListRow, ListRowDetails, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { BackupArchive, BackupController, BackupOperationKind } from "@/features/application/model/backup-source"

type Flow =
  | { kind: "idle" }
  | { kind: "backup-select" }
  | { kind: "backup-review" }
  | { kind: "backup-running-confirm" }
  | { kind: "restore-review"; archive: BackupArchive; sourceName: string; newName: string }
  | { kind: "invalid-archive"; reason: string }
  | { kind: "destination-error"; reason: string }
  | { kind: "unavailable"; operation: BackupOperationKind; reason: string }
  | { kind: "cancel-confirm"; operation: BackupOperationKind }

function Notice({ tone, title, children }: { tone: "neutral" | "success" | "warning" | "danger"; title: string; children: React.ReactNode }) {
  const classes = tone === "danger" ? "border-destructive/20 bg-destructive/[.06]" : tone === "warning" ? "border-amber-500/25 bg-amber-500/[.07]" : tone === "success" ? "border-emerald-500/25 bg-emerald-500/[.06]" : "border-border bg-muted/30"
  const Icon = tone === "danger" ? CircleX : tone === "warning" ? TriangleAlert : tone === "success" ? Check : Circle
  return <div className={`rounded-lg border p-3 ${classes}`} role={tone === "danger" ? "alert" : "status"}>
    <div className="flex gap-2"><Icon className={tone === "danger" ? "mt-0.5 size-3.5 shrink-0 text-destructive" : tone === "warning" ? "mt-0.5 size-3.5 shrink-0 text-amber-600" : tone === "success" ? "mt-0.5 size-3.5 shrink-0 text-emerald-600" : "mt-0.5 size-3.5 shrink-0 text-muted-foreground"} aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-xs font-medium">{title}</p><div className="mt-1 text-[11px] leading-4 text-muted-foreground">{children}</div></div></div>
  </div>
}

export interface BackupPageProps { source: ApplicationSource; backup: BackupController; onBusyChange?: (busy: boolean) => void }

export function BackupPage(props: BackupPageProps) {
  return <BackupPageContent {...props} />
}

function BackupPageContent({ source, backup, onBusyChange }: BackupPageProps) {
  const [flow, setFlow] = useState<Flow>({ kind: "idle" })
  const [destination, setDestination] = useState(backup.state.destination ?? source.backup.destination)
  const [selectedIDs, setSelectedIDs] = useState(() => new Set(source.workspaces.filter(({ machine }) => machine.kind === "vm").map(({ machine }) => machine.id)))
  const [expandedArchive, setExpandedArchive] = useState<string | null>(null)
  const operation = backup.state.operation
  const busy = operation?.kind === "running"
  const vmWorkspaces = source.workspaces.filter(({ machine }) => machine.kind === "vm")
  const selected = new Set(vmWorkspaces.filter(({ machine }) => selectedIDs.has(machine.id)).map(({ machine }) => machine.name))
  const selectedRunning = vmWorkspaces.filter(({ machine, state }) => selected.has(machine.name) && state === "running").map(({ machine }) => machine.name)
  const controlsDisabled = Boolean(busy)

  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => { if (busy) onBusyChange?.(false) } }, [busy, onBusyChange])

  function unavailableFlow(operation: BackupOperationKind): Flow {
    return { kind: "unavailable", operation, reason: backup.state.availabilityMessage ?? "Silo could not read backup state. Refresh to confirm the operation result." }
  }

  function begin(next: Flow, operation: BackupOperationKind) {
    if (backup.state.availability === "unavailable") { setFlow(unavailableFlow(operation)); return }
    backup.actions.dismissOperation()
    setFlow(next)
  }

  function reviewBackup() {
    if (backup.state.unsupportedStorage && selected.has(backup.state.unsupportedStorage.sandbox)) { setFlow({ kind: "backup-review" }); return }
    if (backup.state.requiredSpaceGB !== undefined && (backup.state.availableSpaceGB === undefined || backup.state.availableSpaceGB < backup.state.requiredSpaceGB)) { setFlow({ kind: "backup-review" }); return }
    setFlow(selectedRunning.length > 0 ? { kind: "backup-running-confirm" } : { kind: "backup-review" })
  }

  function startBackup() {
    if (selected.size === 0) return
    backup.actions.startBackup(destination, [...selected])
    setFlow({ kind: "idle" })
  }

  async function inspect(selection: BackupArchive) {
    if (backup.state.availability === "unavailable") { setFlow(unavailableFlow("restore")); return }
    try {
      const result = await backup.actions.inspectArchive(selection)
      if (!result.valid) { setFlow({ kind: "invalid-archive", reason: result.reason ?? "This backup could not be validated." }); return }
      const base = result.archive.sandboxes[0] || "sandbox"
      setFlow({ kind: "restore-review", archive: result.archive, sourceName: base, newName: `${base}-restored` })
    } catch (error) {
      setFlow({ kind: "invalid-archive", reason: error instanceof Error ? error.message : String(error) })
    }
  }

  async function chooseArchive() {
    if (backup.state.availability === "unavailable") { setFlow(unavailableFlow("restore")); return }
    try {
      const result = await backup.actions.chooseArchive()
      if (!result) return
      if (!result.valid) { setFlow({ kind: "invalid-archive", reason: result.reason ?? "This backup could not be validated." }); return }
      const base = result.archive.sandboxes[0] || "sandbox"
      setFlow({ kind: "restore-review", archive: result.archive, sourceName: base, newName: `${base}-restored` })
    } catch (error) {
      setFlow({ kind: "invalid-archive", reason: error instanceof Error ? error.message : String(error) })
    }
  }

  async function chooseDestination() {
    try {
      const selected = await backup.actions.chooseDestination()
      if (selected) setDestination(selected)
    } catch (error) {
      setFlow({ kind: "destination-error", reason: error instanceof Error ? error.message : String(error) })
    }
  }

  function operationPanel(kind: BackupOperationKind) {
    if (!operation || operation.operation !== kind) return null
    if (operation.kind === "running" && flow.kind === "cancel-confirm" && flow.operation === kind) return <ListRowDetails label={`Cancel ${kind}`}>
      <Notice tone="warning" title={kind === "backup" ? "Cancel after the current safe point?" : `Cancel and remove ${operation.targetName}?`}>
        {kind === "backup" ? "Silo will stop writing, remove the incomplete file, and restore the previous running state where possible. Existing backups stay unchanged." : "Silo will stop at a safe point and remove the incomplete new sandbox. The backup file and existing sandboxes stay unchanged."}
      </Notice>
      <div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={() => setFlow({ kind: "idle" })}>Keep {kind === "backup" ? "backing up" : "restoring"}</Button><Button variant="outline" size="xs" onClick={() => { backup.actions.cancelOperation(); setFlow({ kind: "idle" }) }}>{kind === "backup" ? "Cancel and clean up" : "Cancel and remove"}</Button></div>
    </ListRowDetails>
    if (operation.kind === "running") return <ListRowDetails label={`${kind === "backup" ? "Backup" : "Restore"} in progress`}>
      <ol className="grid gap-3">{operation.phases.map((phase) => <li key={phase.title} className="grid grid-cols-[1rem_1fr] gap-x-2"><span className={`mt-1 size-2 rounded-full ${phase.tone === "succeeded" ? "bg-emerald-500" : phase.tone === "running" ? "bg-foreground" : "bg-muted-foreground/30"}`} /><div className="min-w-0"><p className="truncate text-xs font-medium" title={phase.title}>{phase.title}</p><p className={phase.tone === "failed" ? "whitespace-pre-wrap text-[11px] text-muted-foreground" : "truncate text-[11px] text-muted-foreground"} title={phase.detail}>{phase.detail}</p></div></li>)}</ol>
      <Progress value={operation.progress} aria-label={kind === "backup" ? "Backup progress" : "Restore progress"} />
      <div className="flex justify-end"><Button variant="outline" size="xs" onClick={() => setFlow({ kind: "cancel-confirm", operation: kind })}>Cancel {kind}…</Button></div>
    </ListRowDetails>
    const tone = operation.outcome === "success" ? "success" : operation.outcome === "restart-required" ? "warning" : operation.outcome === "failed" ? "danger" : "neutral"
    return <ListRowDetails label={`${kind === "backup" ? "Backup" : "Restore"} result`}>
      <Notice tone={tone} title={operation.title}><p>{operation.message}</p>{operation.detail && <p className="mt-1">{operation.detail}</p>}</Notice>
      <div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={() => backup.actions.dismissOperation()}>Done</Button>{operation.outcome === "restart-required" && <Button variant="outline" size="xs" onClick={() => backup.actions.retryStart(operation.runningNames[0])}>Retry start</Button>}{operation.outcome === "failed" && <Button variant="outline" size="xs" onClick={() => kind === "backup" ? setFlow({ kind: "backup-select" }) : void chooseArchive()}>Review and retry</Button>}</div>
    </ListRowDetails>
  }

  const requiredSpace = backup.state.requiredSpaceGB === undefined ? undefined : Math.ceil(backup.state.requiredSpaceGB * 10) / 10
  const availableSpace = backup.state.availableSpaceGB === undefined ? "Unknown" : Math.floor(backup.state.availableSpaceGB * 10) / 10

  const restoreNameConflict = flow.kind === "restore-review" && source.workspaces.some(({ machine }) => machine.name.toLowerCase() === flow.newName.toLowerCase())
  const restoreSpaceBlocked = flow.kind === "restore-review" && (backup.state.requiredSpaceGB !== undefined && (backup.state.availableSpaceGB === undefined || backup.state.availableSpaceGB < backup.state.requiredSpaceGB))

  return <div className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-5 sm:px-6 sm:py-6">
    <header><h2 className="text-sm font-semibold">Backup</h2><p className="mt-1 text-xs text-muted-foreground">Create a self-contained Silo backup or restore one as a new sandbox.</p></header>
    <ListCard><ul className="divide-y divide-border" aria-label="Backup controls">
      <li><ListRow icon={<ListRowIcon><Archive className="size-3.5" /></ListRowIcon>} title={<h3>Create backup</h3>} detail="Back up selected sandboxes to a folder." actions={<Button variant="outline" size="xs" disabled={controlsDisabled} aria-expanded={flow.kind.startsWith("backup")} onClick={() => begin({ kind: "backup-select" }, "backup")}>Create backup…</Button>} />
        {flow.kind === "backup-select" && <ListRowDetails label="Choose backup">
          <div className="grid gap-2 text-[11px]">{vmWorkspaces.map(({ machine, state }) => <label key={machine.id} className="flex items-center gap-2"><Checkbox checked={selected.has(machine.name)} onCheckedChange={(checked) => setSelectedIDs((current) => { const next = new Set(current); if (checked) next.add(machine.id); else next.delete(machine.id); return next })} />{machine.name}<span className="text-muted-foreground">{state[0].toUpperCase() + state.slice(1)}</span></label>)}
            <label className="grid gap-1">Destination<div className="flex gap-2"><Input value={destination} readOnly aria-label="Destination" /><Button variant="outline" size="xs" onClick={() => { void chooseDestination() }}>Change…</Button></div></label>
          </div><p className="text-[11px] text-muted-foreground">Includes managed disks, required image data, and Silo VM settings. Archive format and compression are automatic.</p>
          <div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={() => setFlow({ kind: "idle" })}>Cancel</Button><Button variant="outline" size="xs" disabled={!destination || selected.size === 0} onClick={reviewBackup}>Review backup</Button></div>
        </ListRowDetails>}
        {flow.kind === "destination-error" && <ListRowDetails label="Destination selection"><Notice tone="danger" title="Destination selection failed"><p>{flow.reason} No backup was created.</p></Notice><div className="flex justify-end"><Button variant="outline" size="xs" onClick={() => setFlow({ kind: "backup-select" })}>Choose again</Button></div></ListRowDetails>}
        {flow.kind === "backup-review" && <ListRowDetails label="Review backup">
          {backup.state.unsupportedStorage && selected.has(backup.state.unsupportedStorage.sandbox) ? <Notice tone="danger" title="Complete backup is blocked"><p>{backup.state.unsupportedStorage.sandbox} uses “{backup.state.unsupportedStorage.label}”, which is outside Silo’s managed disk and cannot be included. No backup was created.</p></Notice>
            : backup.state.requiredSpaceGB !== undefined && backup.state.availableSpaceGB === undefined ? <Notice tone="danger" title="Destination space is unavailable"><p>Silo could not verify the space needed to create a complete backup. No backup was created.</p></Notice>
            : backup.state.requiredSpaceGB !== undefined && backup.state.availableSpaceGB !== undefined && backup.state.availableSpaceGB < backup.state.requiredSpaceGB ? <Notice tone="danger" title="Not enough space at this destination"><p>About {requiredSpace} GB is needed; {availableSpace} GB is available. The estimate includes temporary export space and is not a reservation.</p></Notice>
            : <><dl className="grid grid-cols-[7rem_1fr] gap-1 text-[11px]"><dt className="text-muted-foreground">Sandboxes</dt><dd>{[...selected].join(", ")}</dd><dt className="text-muted-foreground">Destination</dt><dd>{destination}</dd>{requiredSpace !== undefined && <><dt className="text-muted-foreground">Space</dt><dd>About {requiredSpace} GB needed · {availableSpace} GB available</dd></>}<dt className="text-muted-foreground">Current state</dt><dd>{selectedRunning.length ? `${selectedRunning.join(", ")} will stop briefly` : "Selected sandboxes are stopped and will stay stopped"}</dd></dl><div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={() => setFlow({ kind: "backup-select" })}>Back</Button><Button variant="outline" size="xs" disabled={selected.size === 0} onClick={startBackup}>Start backup</Button></div></>}
        </ListRowDetails>}
        {flow.kind === "backup-running-confirm" && <ListRowDetails label="Running sandbox interruption"><Notice tone="warning" title={`${selectedRunning.join(", ")} must stop briefly`}><p>Silo will stop the selected running sandbox, save a disk copy, then restart it while the backup continues writing. Programs inside the VM start fresh.</p></Notice><div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={() => setFlow({ kind: "backup-select" })}>Cancel</Button><Button variant="outline" size="xs" disabled={selected.size === 0} onClick={startBackup}>Stop and back up</Button></div></ListRowDetails>}
        {flow.kind === "unavailable" && flow.operation === "backup" && <ListRowDetails label="Backup unavailable"><Notice tone="danger" title="Backup is unavailable"><p>{flow.reason}</p></Notice><div className="flex justify-end"><Button variant="ghost" size="xs" onClick={() => setFlow({ kind: "idle" })}>Dismiss</Button></div></ListRowDetails>}
        {operationPanel("backup")}
      </li>
      <li><ListRow icon={<ListRowIcon><RotateCcw className="size-3.5" /></ListRowIcon>} title={<h3>Restore backup</h3>} detail="Validate an archive and restore it as a new sandbox." actions={<Button variant="outline" size="xs" disabled={controlsDisabled} onClick={() => { if (backup.state.availability === "unavailable") begin(unavailableFlow("restore"), "restore"); else void chooseArchive() }}>Choose backup…</Button>} />
        {flow.kind === "invalid-archive" && <ListRowDetails label="Archive validation"><Notice tone="danger" title="This backup cannot be restored"><p>{flow.reason} No sandbox data changed.</p></Notice><div className="flex justify-end"><Button variant="outline" size="xs" onClick={() => { void chooseArchive() }}>Choose another backup</Button></div></ListRowDetails>}
        {flow.kind === "restore-review" && <ListRowDetails label="Review restore">
          <Notice tone="success" title="Backup validated"><p>{flow.archive.name} · format and checksum verified</p></Notice>
          {restoreNameConflict && <Notice tone="danger" title={`The name ${flow.newName} already exists`}><p>Choose a new sandbox name. Silo will not overwrite an existing sandbox.</p></Notice>}
          {restoreSpaceBlocked && <Notice tone="danger" title={backup.state.availableSpaceGB === undefined ? "Managed storage is unavailable" : "Not enough managed storage"}><p>{backup.state.availableSpaceGB === undefined ? "Silo could not verify the required managed storage. No sandbox was created." : `About ${requiredSpace} GB is needed; ${availableSpace} GB is available. No sandbox was created.`}</p></Notice>}
          {flow.archive.sandboxes.length > 1 && <label className="grid gap-1 text-[11px]">Sandbox to restore<Select value={flow.sourceName} onValueChange={(sourceName) => setFlow({ ...flow, sourceName, newName: flow.newName === `${flow.sourceName}-restored` ? `${sourceName}-restored` : flow.newName })}><SelectTrigger className="h-7 text-[11px]" aria-label="Sandbox to restore"><SelectValue /></SelectTrigger><SelectContent>{flow.archive.sandboxes.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></label>}
          <label className="grid gap-1 text-[11px]">New sandbox name<Input autoFocus value={flow.newName} aria-invalid={restoreNameConflict} onChange={(event) => setFlow({ ...flow, newName: event.target.value })} /></label>
          <dl className="grid grid-cols-[7rem_1fr] gap-1 text-[11px]"><dt className="text-muted-foreground">Source</dt><dd>{flow.sourceName}</dd><dt className="text-muted-foreground">Location</dt><dd>Silo managed storage</dd>{requiredSpace !== undefined && <><dt className="text-muted-foreground">Space</dt><dd>{requiredSpace} GB needed · {availableSpace} GB available</dd></>}</dl>
          <p className="text-[11px] text-muted-foreground">Restores saved disk files and Silo settings. Programs start fresh. Existing sandboxes and backups stay unchanged.</p>
          <div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={() => setFlow({ kind: "idle" })}>Cancel</Button><Button variant="outline" size="xs" disabled={!flow.newName || restoreNameConflict || restoreSpaceBlocked} onClick={() => { backup.actions.startRestore(flow.archive, flow.newName, flow.sourceName); setFlow({ kind: "idle" }) }}>Restore new sandbox</Button></div>
        </ListRowDetails>}
        {flow.kind === "unavailable" && flow.operation === "restore" && <ListRowDetails label="Restore unavailable"><Notice tone="danger" title="Restore is unavailable"><p>{flow.reason}</p></Notice><div className="flex justify-end"><Button variant="ghost" size="xs" onClick={() => setFlow({ kind: "idle" })}>Dismiss</Button></div></ListRowDetails>}
        {operationPanel("restore")}
      </li>
    </ul></ListCard>
    <section className="grid gap-2"><h3 className="text-xs font-medium">Recent backups</h3><ListCard><ul className="divide-y divide-border" aria-label="Recent backups">{backup.state.archives.length === 0 && <li><ListRow icon={<ListRowIcon><Archive className="size-3.5" /></ListRowIcon>} title="No backups yet" detail="Completed backups will appear here." /></li>}{backup.state.archives.map((archive) => <Collapsible key={archive.name} open={expandedArchive === archive.name} onOpenChange={(open) => setExpandedArchive(open ? archive.name : null)} asChild><li><DisclosureHeader icon={<ListRowIcon className="bg-emerald-500/10 text-emerald-600"><Check className="size-3.5" /></ListRowIcon>} title={archive.name} detail={[archive.completedLabel, archive.size, `${archive.sandboxes.length} sandboxes`].join(" · ")} label={`Details for ${archive.name}`} /><CollapsibleContent><ListRowDetails label={`Archive details for ${archive.name}`}><p className="text-[11px] text-muted-foreground">{archive.destination} · {archive.sandboxes.join(", ")}</p><div className="flex justify-end"><Button variant="outline" size="xs" disabled={controlsDisabled} onClick={() => { void inspect(archive) }}>Restore…</Button></div></ListRowDetails></CollapsibleContent></li></Collapsible>)}</ul></ListCard></section>
  </div>
}
