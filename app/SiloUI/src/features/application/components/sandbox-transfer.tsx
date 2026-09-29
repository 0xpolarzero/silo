import { useEffect, useEffectEvent, useId, useRef, useState } from "react"
import { Check, Circle, CircleX, TriangleAlert, Upload, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { BackupArchive, BackupController, BackupOperation } from "@/features/application/model/backup-source"
import { validateSandboxName } from "@/features/onboarding/model/machine-configuration"

export function Notice({ tone, title, children }: { tone: "neutral" | "success" | "warning" | "danger"; title: string; children: React.ReactNode }) {
  const Icon = tone === "danger" ? CircleX : tone === "warning" ? TriangleAlert : tone === "success" ? Check : Circle
  return <div role={tone === "danger" ? "alert" : "status"}>
    <div className="flex gap-2"><Icon className={tone === "danger" ? "mt-0.5 size-3.5 shrink-0 text-destructive" : tone === "warning" ? "mt-0.5 size-3.5 shrink-0 text-amber-600" : tone === "success" ? "mt-0.5 size-3.5 shrink-0 text-emerald-600" : "mt-0.5 size-3.5 shrink-0 text-muted-foreground"} aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-xs font-medium">{title}</p><div className="mt-1 text-[11px] leading-4 text-muted-foreground">{children}</div></div></div>
  </div>
}

const verbConfig = {
  export: {
    progressLabel: "Export progress",
    cancel: "Cancel export…",
    keep: "Keep exporting",
    confirm: "Cancel and clean up",
    cancelTitle: (_operation: BackupOperation) => "Cancel this export?",
    cancelBody: "Silo will stop writing and remove the incomplete file. Existing exports and this sandbox stay unchanged.",
    success: "Export completed successfully.",
  },
  import: {
    progressLabel: "Import progress",
    cancel: "Cancel import…",
    keep: "Keep importing",
    confirm: "Cancel and remove",
    cancelTitle: (operation: BackupOperation) => `Cancel and remove ${operation.targetName}?`,
    cancelBody: "Silo will stop at a safe point and remove the incomplete new sandbox. The export file and existing sandboxes stay unchanged.",
    success: "Sandbox imported successfully.",
  },
} as const

/** Shared running/result renderer for an export ("backup") or import ("restore") operation. */
function OperationStatus({ verb, operation, backup, onDone, onRetry, extraSuccess }: {
  verb: "export" | "import"
  operation: BackupOperation
  backup: BackupController
  onDone: () => void
  onRetry?: () => void
  extraSuccess?: React.ReactNode
}) {
  const config = verbConfig[verb]
  const [confirmCancel, setConfirmCancel] = useState(false)

  if (operation.kind === "running") {
    if (confirmCancel) return <div className="grid gap-3">
      <Notice tone="warning" title={config.cancelTitle(operation)}>{config.cancelBody}</Notice>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={() => setConfirmCancel(false)}>{config.keep}</Button>
        <Button variant="outline" size="xs" onClick={() => { backup.actions.cancelOperation(); setConfirmCancel(false) }}>{config.confirm}</Button>
      </div>
    </div>
    return <div className="grid gap-3">
      <ol className="grid gap-3">{operation.phases.map((phase) => <li key={phase.title} className="grid grid-cols-[1rem_1fr] gap-x-2"><span className={`mt-1 size-2 rounded-full ${phase.tone === "succeeded" ? "bg-emerald-500" : phase.tone === "running" ? "bg-foreground" : "bg-muted-foreground/30"}`} /><div className="min-w-0"><p className="truncate text-xs font-medium" title={phase.title}>{phase.title}</p><p className={phase.tone === "failed" ? "whitespace-pre-wrap text-[11px] text-muted-foreground" : "truncate text-[11px] text-muted-foreground"} title={phase.detail}>{phase.detail}</p></div></li>)}</ol>
      <Progress value={operation.indeterminate ? null : operation.progress} aria-label={config.progressLabel} />
      <div className="flex justify-end"><Button variant="outline" size="xs" disabled={operation.canCancel === false} onClick={() => setConfirmCancel(true)}>{config.cancel}</Button></div>
    </div>
  }

  if (operation.outcome === "success") return <div className="grid gap-2">
    <div className="flex items-center gap-1.5 text-xs text-emerald-600" role="status"><Check className="size-3.5 shrink-0" aria-hidden="true" /><span className="flex-1">{config.success}</span><Button variant="ghost" size="icon-xs" aria-label="Dismiss success" onClick={onDone}><X className="size-3.5" /></Button></div>
    {extraSuccess}
  </div>

  const tone = operation.outcome === "restart-required" ? "warning" : operation.outcome === "failed" ? "danger" : "neutral"
  return <div className="grid gap-3">
    <Notice tone={tone} title={operation.title}><p>{operation.message}</p>{operation.detail && <p className="mt-1">{operation.detail}</p>}</Notice>
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="xs" onClick={onDone}>Done</Button>
      {operation.outcome === "restart-required" && <Button variant="outline" size="xs" onClick={() => backup.actions.retryStart(operation.runningNames[0])}>Retry start</Button>}
      {operation.outcome === "failed" && onRetry && <Button variant="outline" size="xs" onClick={onRetry}>Review and retry</Button>}
    </div>
  </div>
}

/**
 * Per-sandbox export, rendered as a local VM row's expanded content. Opening it starts the
 * native folder picker (autoStart); a chosen folder begins the export immediately.
 */
export function ExportPanel({ backup, sandboxName, checkpoint, autoStart, onClose }: {
  backup: BackupController
  sandboxName: string
  checkpoint?: { id: string; name: string }
  autoStart: boolean
  onClose: () => void
}) {
  const operation = backup.state.operation
  const targeted = operation && operation.operation === "backup" && operation.archive.sandboxes.includes(sandboxName) ? operation : null
  const [status, setStatus] = useState<"idle" | "choosing" | "unavailable" | "destination-error">("idle")
  const [reason, setReason] = useState("")
  const startedRef = useRef(false)

  async function choose() {
    if (backup.state.availability === "unavailable") { setStatus("unavailable"); return }
    setStatus("choosing")
    try {
      const destination = await backup.actions.chooseDestination()
      if (!destination) { onClose(); return }
      backup.actions.startBackup(destination, [sandboxName], checkpoint?.id)
      setStatus("idle")
    } catch (error) {
      setReason(error instanceof Error ? error.message : String(error))
      setStatus("destination-error")
    }
  }
  const autoStartExport = useEffectEvent(() => { void choose() })

  useEffect(() => {
    if (!autoStart || startedRef.current || targeted) return
    startedRef.current = true
    autoStartExport()
  }, [autoStart, targeted])

  const done = () => { backup.actions.dismissOperation(); onClose() }

  return <section aria-label={`Export ${sandboxName}`} className="grid gap-3 border-t border-border p-3 text-xs">
    <div><h3 className="font-medium">{checkpoint ? <>Export checkpoint “{checkpoint.name}”</> : "Export"}</h3><p className="mt-0.5 text-muted-foreground">{checkpoint
      ? "Save a self-contained copy of this checkpoint to a folder. Import restores its disks only, so the imported sandbox starts fresh."
      : <>Save a self-contained copy of {sandboxName}’s disks to a folder. A running sandbox keeps running.</>}</p></div>
    {status === "unavailable"
      ? <><Notice tone="danger" title="Export is unavailable"><p>{backup.state.availabilityMessage ?? "Export is not available in this Silo build. No sandbox data was changed."}</p></Notice><div className="flex justify-end"><Button variant="ghost" size="xs" onClick={onClose}>Dismiss</Button></div></>
      : status === "destination-error"
      ? <><Notice tone="danger" title="Destination selection failed"><p>{reason} No export was created.</p></Notice><div className="flex justify-end"><Button variant="outline" size="xs" onClick={() => { void choose() }}>Choose again</Button></div></>
      : targeted
      ? <OperationStatus verb="export" operation={targeted} backup={backup} onDone={done} onRetry={() => { void choose() }} extraSuccess={targeted.kind === "result" && targeted.outcome === "success" ? <dl className="grid grid-cols-[5rem_1fr] gap-1 text-[11px]"><dt className="text-muted-foreground">File</dt><dd className="truncate" title={targeted.archive.name}>{targeted.archive.name} · {targeted.archive.size}</dd><dt className="text-muted-foreground">Folder</dt><dd className="truncate" title={targeted.archive.destination}>{targeted.archive.destination}</dd></dl> : undefined} />
      : status === "choosing"
      ? <p className="text-muted-foreground" role="status">Choose a folder in the file picker.</p>
      : <p className="text-muted-foreground" role="status">Preparing export…</p>}
  </section>
}

type ImportFlow =
  | { kind: "choosing" }
  | { kind: "checking"; archivePath?: string }
  | { kind: "invalid"; reason: string }
  | { kind: "review"; archive: BackupArchive; sourceName: string; newName: string }
  | { kind: "idle" }

/**
 * Import a sandbox from an export file, rendered near the top of the sandboxes overview.
 * Opening it starts the native file picker; a validated archive is restored as a new
 * stopped sandbox.
 */
export function ImportPanel({ source, backup, onClose }: {
  source: ApplicationSource
  backup: BackupController
  onClose: () => void
}) {
  const operation = backup.state.operation
  const targeted = operation && operation.operation === "restore" ? operation : null
  const [flow, setFlow] = useState<ImportFlow>({ kind: "idle" })
  const draft = useRef<Extract<ImportFlow, { kind: "review" }> | null>(null)
  const startedRef = useRef(false)
  const nameErrorID = useId()
  const nameInput = useRef<HTMLInputElement>(null)

  async function chooseImport() {
    if (backup.state.availability === "unavailable") { setFlow({ kind: "invalid", reason: backup.state.availabilityMessage ?? "Import is not available in this Silo build." }); return }
    backup.actions.dismissOperation()
    setFlow({ kind: "choosing" })
    try {
      const result = await backup.actions.chooseArchive((archivePath) => setFlow({ kind: "checking", archivePath }))
      if (!result) { onClose(); return }
      if (!result.valid) { setFlow({ kind: "invalid", reason: result.reason ?? "This export file could not be validated." }); return }
      const base = result.archive.sandboxes[0] || "sandbox"
      setFlow({ kind: "review", archive: result.archive, sourceName: base, newName: `${base}-imported` })
    } catch (error) {
      setFlow({ kind: "invalid", reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const autoStartImport = useEffectEvent(() => { void chooseImport() })
  useEffect(() => {
    if (startedRef.current || targeted) return
    startedRef.current = true
    autoStartImport()
  }, [targeted])

  useEffect(() => {
    if (flow.kind !== "review") return
    nameInput.current?.focus({ preventScroll: true })
    nameInput.current?.select()
  }, [flow.kind])

  const done = () => { backup.actions.dismissOperation(); onClose() }
  const review = flow.kind === "review" ? flow : null
  const nameError = review ? validateSandboxName(review.newName) : undefined
  const nameConflict = review ? source.workspaces.filter((w) => !w.computer).some(({ machine }) => machine.name.toLowerCase() === review.newName.toLowerCase()) : false

  return <section aria-label="Import sandbox" className="grid gap-3 rounded-md border border-border p-3 text-xs">
    <div className="flex items-center gap-2"><Upload className="size-4 shrink-0" aria-hidden="true" /><span className="flex-1 text-xs font-semibold">Import sandbox</span><Button variant="ghost" size="xs" onClick={onClose}>Close</Button></div>
    {targeted
      ? <OperationStatus verb="import" operation={targeted} backup={backup} onDone={done} onRetry={() => draft.current ? setFlow(draft.current) : void chooseImport()} />
      : flow.kind === "choosing"
      ? <p className="text-muted-foreground" role="status">Choose an export file in the file picker.</p>
      : flow.kind === "checking"
      ? <><p className="font-medium" role="status">Checking export…</p><Progress value={null} aria-label="Export validation progress" /></>
      : flow.kind === "invalid"
      ? <><Notice tone="danger" title="This export cannot be imported"><p>{flow.reason} No sandbox data changed.</p></Notice><div className="flex justify-end"><Button variant="outline" size="xs" onClick={() => { void chooseImport() }}>Choose another file</Button></div></>
      : review
      ? <div className="grid gap-3">
          <Notice tone="success" title="Export validated"><p>{review.archive.name} · format and checksum verified</p></Notice>
          {review.archive.sandboxes.length > 1 && <label className="grid gap-1">Sandbox to import<Select value={review.sourceName} onValueChange={(sourceName) => setFlow({ ...review, sourceName, newName: review.newName === `${review.sourceName}-imported` ? `${sourceName}-imported` : review.newName })}><SelectTrigger className="h-7 text-[11px]" aria-label="Sandbox to import"><SelectValue /></SelectTrigger><SelectContent>{review.archive.sandboxes.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></label>}
          <label className="grid gap-1">New sandbox name<Input ref={nameInput} value={review.newName} aria-invalid={Boolean(nameError) || nameConflict} aria-describedby={nameError ? nameErrorID : undefined} onChange={(event) => setFlow({ ...review, newName: event.target.value })} />{nameError && <span id={nameErrorID} className="text-destructive">{nameError}</span>}{!nameError && nameConflict && <span className="text-destructive">A sandbox named {review.newName} already exists.</span>}</label>
          <p className="text-[11px] text-muted-foreground">Imports saved disk files and Silo settings as a new stopped sandbox. Existing sandboxes and export files stay unchanged.</p>
          <div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={onClose}>Cancel</Button><Button variant="outline" size="xs" disabled={Boolean(nameError) || nameConflict} onClick={() => { draft.current = review; backup.actions.startRestore(review.archive, review.newName, review.sourceName); setFlow({ kind: "idle" }) }}>Import</Button></div>
        </div>
      : <p className="text-muted-foreground" role="status">Preparing import…</p>}
  </section>
}
