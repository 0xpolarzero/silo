import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Dialog } from "radix-ui"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { BackupArchive, BackupController, BackupOperation } from "@/features/application/model/backup-source"
import { validateSandboxName } from "@/features/onboarding/model/machine-configuration"

/** One toast tracks the single in-flight export or import; updating it in place keeps the
 * notification tied to backend truth across navigation. */
const TRANSFER_TOAST_ID = "backup-operation"

const revealLabel = () => (navigator.platform.startsWith("Mac") ? "Show in Finder" : "Show in folder")

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function RunningToast({ operation }: { operation: Extract<BackupOperation, { kind: "running" }> }) {
  const phase = operation.phases.find((entry) => entry.tone === "running") ?? operation.phases.at(-1)
  return <div className="grid gap-1.5">
    {phase && <p className="text-xs text-muted-foreground">{phase.detail || phase.title}</p>}
    <Progress value={operation.indeterminate ? null : operation.progress} aria-label={operation.operation === "backup" ? "Export progress" : "Import progress"} />
  </div>
}

type ImportReview =
  | { kind: "checking" }
  | { kind: "invalid"; reason: string }
  | { kind: "review"; archive: BackupArchive; sourceName: string; newName: string }

/** Import review dialog: validates the chosen archive summary, picks a source sandbox when
 * several are present, and names the new sandbox. Progress continues in the toast. */
function ImportDialog({ source, review, onReview, onImport, onClose, onRetry }: {
  source: ApplicationSource
  review: ImportReview
  onReview: (review: ImportReview) => void
  onImport: (archive: BackupArchive, newName: string, sourceName: string) => void
  onClose: () => void
  onRetry: () => void
}) {
  const nameErrorID = useId()
  const nameInput = useRef<HTMLInputElement>(null)
  const isReview = review.kind === "review" ? review : null

  useEffect(() => {
    if (review.kind !== "review") return
    nameInput.current?.focus({ preventScroll: true })
    nameInput.current?.select()
  }, [review.kind])

  const nameError = isReview ? validateSandboxName(isReview.newName) : undefined
  const nameConflict = isReview
    ? source.workspaces.filter((w) => !w.computer).some(({ machine }) => machine.name.toLowerCase() === isReview.newName.toLowerCase())
    : false

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
      <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none">
        <Dialog.Title className="text-sm font-medium">{isReview ? `Import ${isReview.archive.name}` : review.kind === "invalid" ? "This export cannot be imported" : "Checking export"}</Dialog.Title>
        {review.kind === "checking" && <>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">Verifying the archive before importing it.</Dialog.Description>
          <div className="mt-3"><Progress value={null} aria-label="Export validation progress" /></div>
        </>}
        {review.kind === "invalid" && <>
          <Dialog.Description className="mt-1 text-xs text-destructive">{review.reason} No sandbox data changed.</Dialog.Description>
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>Choose another file</Button>
          </div>
        </>}
        {isReview && <>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">Imports saved disk files and Silo settings as a new stopped sandbox. Existing sandboxes and export files stay unchanged.</Dialog.Description>
          <div className="mt-3 grid gap-3 text-xs">
            {isReview.archive.sandboxes.length > 1 && <label className="grid gap-1">Sandbox to import<Select value={isReview.sourceName} onValueChange={(sourceName) => onReview({ ...isReview, sourceName, newName: isReview.newName === `${isReview.sourceName}-imported` ? `${sourceName}-imported` : isReview.newName })}><SelectTrigger className="h-7 text-[11px]" aria-label="Sandbox to import"><SelectValue /></SelectTrigger><SelectContent>{isReview.archive.sandboxes.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></label>}
            <label className="grid gap-1">New sandbox name<Input ref={nameInput} value={isReview.newName} aria-invalid={Boolean(nameError) || nameConflict} aria-describedby={nameError ? nameErrorID : undefined} onChange={(event) => onReview({ ...isReview, newName: event.target.value })} />{nameError && <span id={nameErrorID} className="text-destructive">{nameError}</span>}{!nameError && nameConflict && <span className="text-destructive">A sandbox named {isReview.newName} already exists.</span>}</label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="button" size="sm" disabled={Boolean(nameError) || nameConflict} onClick={() => onImport(isReview.archive, isReview.newName, isReview.sourceName)}>Import</Button>
            </div>
          </div>
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function CancelImportDialog({ targetName, onKeep, onConfirm }: { targetName?: string; onKeep: () => void; onConfirm: () => void }) {
  return <Dialog.Root open onOpenChange={(open) => { if (!open) onKeep() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
      <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none">
        <Dialog.Title className="text-sm font-medium">{targetName ? `Cancel and remove ${targetName}?` : "Cancel this import?"}</Dialog.Title>
        <Dialog.Description className="mt-1 text-xs text-muted-foreground">Silo will stop at a safe point and remove the incomplete new sandbox. The export file and existing sandboxes stay unchanged.</Dialog.Description>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onKeep}>Keep importing</Button>
          <Button type="button" variant="outline" size="sm" onClick={onConfirm}>Cancel and remove</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export interface SandboxTransfer {
  /** Pick a folder, then export a sandbox (or one of its checkpoints) as a background toast. */
  exportSandbox: (sandboxName: string, checkpoint?: { id: string; name: string }) => Promise<void>
  /** Pick an export file, validate it, then open the import review dialog. */
  beginImport: () => Promise<void>
  /** Import dialog and cancel-confirmation dialog to render once near the app root. */
  dialogs: ReactNode
}

/**
 * Drives export and import as background notifications: one toast reflects the global
 * `backup.state.operation`, updated in place. Export starts directly after a folder is
 * chosen; import opens a review dialog first, then continues in the toast.
 */
export function useSandboxTransfer(backup: BackupController, options: { source: ApplicationSource; openSandbox?: (id: string) => void }): SandboxTransfer {
  const backupRef = useRef(backup)
  backupRef.current = backup
  const optionsRef = useRef(options)
  optionsRef.current = options
  // The running export's checkpoint name (if any); used for toast titles across navigation.
  const checkpointRef = useRef<string | undefined>(undefined)
  // Retry handler for the current operation, replayed from a failure toast's Retry action.
  const retryRef = useRef<(() => void) | undefined>(undefined)
  const reviewDraftRef = useRef<Extract<ImportReview, { kind: "review" }> | null>(null)
  const [review, setReview] = useState<ImportReview | null>(null)
  const [confirmingCancel, setConfirmingCancel] = useState(false)

  async function exportSandbox(sandboxName: string, checkpoint?: { id: string; name: string }) {
    const controller = backupRef.current
    if (controller.state.availability === "unavailable") {
      toast.error("Export is unavailable", { id: TRANSFER_TOAST_ID, duration: Infinity, closeButton: true, description: controller.state.availabilityMessage ?? "Export is not available in this Silo build. No sandbox data was changed." })
      return
    }
    let destination: string | null
    try { destination = await controller.actions.chooseDestination() }
    catch (error) { toast.error("Could not choose a folder", { id: TRANSFER_TOAST_ID, duration: Infinity, closeButton: true, description: `${errorText(error)} No export was created.` }); return }
    if (!destination) return
    checkpointRef.current = checkpoint?.name
    retryRef.current = () => { void exportSandbox(sandboxName, checkpoint) }
    controller.actions.startBackup(destination, [sandboxName], checkpoint?.id)
  }

  async function beginImport() {
    const controller = backupRef.current
    if (controller.state.availability === "unavailable") {
      setReview({ kind: "invalid", reason: controller.state.availabilityMessage ?? "Import is not available in this Silo build." })
      return
    }
    controller.actions.dismissOperation()
    let result
    try { result = await controller.actions.chooseArchive(() => setReview({ kind: "checking" })) }
    catch (error) { setReview({ kind: "invalid", reason: errorText(error) }); return }
    if (!result) { setReview(null); return }
    if (!result.valid) { setReview({ kind: "invalid", reason: result.reason ?? "This export file could not be validated." }); return }
    const base = result.archive.sandboxes[0] || "sandbox"
    setReview({ kind: "review", archive: result.archive, sourceName: base, newName: `${base}-imported` })
  }

  // Reflect the authoritative operation as a single toast, keyed by a stable id.
  useEffect(() => {
    const controller = backupRef.current
    const operation = controller.state.operation
    if (!operation) { toast.dismiss(TRANSFER_TOAST_ID); return }
    const isExport = operation.operation === "backup"

    if (operation.kind === "running") {
      const title = isExport
        ? (checkpointRef.current ? `Exporting checkpoint “${checkpointRef.current}”` : `Exporting ${operation.archive.sandboxes.join(", ") || "sandbox"}`)
        : `Importing ${operation.targetName ?? "sandbox"}`
      const cancel = () => {
        if (isExport) backupRef.current.actions.cancelOperation()
        else setConfirmingCancel(true)
      }
      toast.loading(title, {
        id: TRANSFER_TOAST_ID,
        duration: Infinity,
        description: <RunningToast operation={operation} />,
        action: operation.canCancel === false ? undefined : <Button variant="outline" size="xs" onClick={cancel}>Cancel</Button>,
      })
      return
    }

    const dismiss = () => backupRef.current.actions.dismissOperation()

    if (operation.outcome === "success") {
      const archive = operation.archive
      const title = isExport ? (checkpointRef.current ? "Checkpoint exported" : "Exported") : `Imported ${operation.targetName ?? archive.sandboxes[0] ?? "sandbox"}`
      const action = isExport
        ? <Button variant="outline" size="xs" onClick={() => {
            backupRef.current.actions.revealArchive(archive).catch((error) => toast.error("Could not reveal the export", { description: errorText(error) }))
          }}>{revealLabel()}</Button>
        : (() => {
            const name = operation.targetName
            const match = name ? optionsRef.current.source.workspaces.find(({ machine, computer }) => !computer && machine.name === name) : undefined
            const open = optionsRef.current.openSandbox
            return match && open ? <Button variant="outline" size="xs" onClick={() => open(match.machine.id)}>Open</Button> : undefined
          })()
      toast.success(title, { id: TRANSFER_TOAST_ID, duration: Infinity, closeButton: true, description: isExport ? `${archive.name} · ${archive.size}` : "Stopped and verified.", action, onDismiss: dismiss })
      return
    }

    if (operation.outcome === "cancelled") {
      toast(operation.title, { id: TRANSFER_TOAST_ID, duration: 4000, description: operation.message, onDismiss: dismiss, onAutoClose: dismiss })
      return
    }

    // failed or restart-required: persistent, actionable.
    const description = <div className="grid gap-1"><p>{operation.message}</p>{operation.detail && <p className="text-muted-foreground">{operation.detail}</p>}</div>
    const retry = operation.outcome === "restart-required"
      ? <Button variant="outline" size="xs" onClick={() => backupRef.current.actions.retryStart(operation.runningNames[0])}>Retry start</Button>
      : retryRef.current
      ? <Button variant="outline" size="xs" onClick={() => retryRef.current?.()}>Retry</Button>
      : undefined
    const notify = operation.outcome === "restart-required" ? toast.warning : toast.error
    notify(operation.title, { id: TRANSFER_TOAST_ID, duration: Infinity, closeButton: true, description, action: retry, onDismiss: dismiss })
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [backup.state.operation])

  const dialogs = <>
    {review && <ImportDialog
      source={optionsRef.current.source}
      review={review}
      onReview={setReview}
      onClose={() => setReview(null)}
      onRetry={() => { setReview(null); void beginImport() }}
      onImport={(archive, newName, sourceName) => {
        reviewDraftRef.current = { kind: "review", archive, sourceName, newName }
        checkpointRef.current = undefined
        retryRef.current = () => { if (reviewDraftRef.current) setReview(reviewDraftRef.current) }
        backupRef.current.actions.startRestore(archive, newName, sourceName)
        setReview(null)
      }}
    />}
    {confirmingCancel && <CancelImportDialog
      targetName={backup.state.operation?.kind === "running" ? backup.state.operation.targetName : undefined}
      onKeep={() => setConfirmingCancel(false)}
      onConfirm={() => { backupRef.current.actions.cancelOperation(); setConfirmingCancel(false) }}
    />}
  </>

  return { exportSandbox, beginImport, dialogs }
}
