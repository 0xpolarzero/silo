import { useEffect, useId, useRef, useState, type ReactNode } from "react"

import { FormPopover } from "@/components/confirm-popover"
import { type OperationStep, dismissOperationToast, showActionFailure, showOperationFailure, showOperationNotice, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { BackupArchive, BackupController, BackupPhase } from "@/features/application/model/backup-source"
import { validateSandboxName } from "@/features/onboarding/model/machine-configuration"

/** One toast tracks the single in-flight export or import; updating it in place keeps the
 * notification tied to backend truth across navigation. */
const TRANSFER_TOAST_ID = "backup-operation"

const revealLabel = () => (navigator.platform.startsWith("Mac") ? "Show in Finder" : "Show in folder")

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type ImportReview =
  | { kind: "checking" }
  | { kind: "invalid"; reason: string }
  | { kind: "review"; archive: BackupArchive; sourceName: string; newName: string }

const stepState: Record<BackupPhase["tone"], OperationStep["state"]> = { succeeded: "done", running: "current", waiting: "pending", failed: "failed" }

/** Import review popover anchored to the sandbox list's Add button: shows the archive summary,
 * picks a source sandbox when several are present, and names the new sandbox. */
function ImportPopover({ source, review, anchor, onReview, onImport, onClose, onRetry }: {
  source: ApplicationSource
  review: ImportReview | null
  anchor: ReactNode
  onReview: (review: ImportReview) => void
  onImport: (archive: BackupArchive, newName: string, sourceName: string) => void
  onClose: () => void
  onRetry: () => void
}) {
  const nameErrorID = useId()
  const isReview = review?.kind === "review" ? review : null
  const nameError = isReview ? validateSandboxName(isReview.newName) : undefined
  const nameConflict = isReview
    ? source.workspaces.filter((w) => !w.computer).some(({ machine }) => machine.name.toLowerCase() === isReview.newName.toLowerCase())
    : false
  const title = isReview ? `Import ${isReview.archive.name}` : review?.kind === "invalid" ? "This export cannot be imported" : "Checking export"
  const fields = !review ? null : review.kind === "checking"
    ? <Progress value={null} aria-label="Export validation progress" />
    : review.kind === "invalid"
    ? <p className="text-destructive">{review.reason} No sandbox data changed.</p>
    : <div className="grid gap-2">
        <p className="text-muted-foreground">{review.archive.size} · {review.archive.sandboxes.length === 1 ? review.archive.sandboxes[0] : `${review.archive.sandboxes.length} sandboxes`}. Imported as a new stopped sandbox; existing sandboxes and the export file stay unchanged.</p>
        {review.archive.sandboxes.length > 1 && <label className="grid gap-1">Sandbox to import<Select value={review.sourceName} onValueChange={(sourceName) => onReview({ ...review, sourceName, newName: review.newName === `${review.sourceName}-imported` ? `${sourceName}-imported` : review.newName })}><SelectTrigger className="h-7 text-[11px]" aria-label="Sandbox to import"><SelectValue /></SelectTrigger><SelectContent>{review.archive.sandboxes.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></label>}
        <label className="grid gap-1">New sandbox name<Input technical value={review.newName} aria-invalid={Boolean(nameError) || nameConflict} aria-describedby={nameError ? nameErrorID : undefined} onChange={(event) => onReview({ ...review, newName: event.target.value })} />{nameError && <span id={nameErrorID} className="text-destructive">{nameError}</span>}{!nameError && nameConflict && <span className="text-destructive">A sandbox named {review.newName} already exists.</span>}</label>
      </div>
  return <FormPopover
    open={review !== null}
    onOpenChange={(open) => { if (!open) onClose() }}
    anchor={<span className="inline-flex">{anchor}</span>}
    align="end"
    title={title}
    fields={fields}
    confirmLabel="Import"
    canSubmit={Boolean(isReview) && !nameError && !nameConflict}
    onSubmit={() => { if (isReview) onImport(isReview.archive, isReview.newName, isReview.sourceName) }}
    description={review?.kind === "invalid" ? <Button type="button" variant="outline" size="xs" onClick={onRetry}>Choose another file</Button> : undefined}
  />
}

export interface SandboxTransfer {
  /** Pick a folder, then export a sandbox (or one of its checkpoints) as a background toast. */
  exportSandbox: (sandboxName: string, checkpoint?: { id: string; name: string }) => Promise<void>
  /** Pick an export file, validate it, then open the import review popover. */
  beginImport: () => Promise<void>
  /** Wraps the sandbox list's Add button: the import review popover anchors to it. */
  importPopover: (anchor: ReactNode) => ReactNode
}

/**
 * Drives export and import as background notifications: one toast reflects the global
 * `backup.state.operation`, updated in place. Export starts directly after a folder is
 * chosen; import opens a review popover first, then continues in the toast.
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

  async function exportSandbox(sandboxName: string, checkpoint?: { id: string; name: string }) {
    const controller = backupRef.current
    if (controller.state.availability === "unavailable") {
      showOperationFailure(TRANSFER_TOAST_ID, "Export is unavailable", { description: controller.state.availabilityMessage ?? "Export is not available in this Silo build. No sandbox data was changed." })
      return
    }
    let destination: string | null
    try { destination = await controller.actions.chooseDestination() }
    catch (error) { showOperationFailure(TRANSFER_TOAST_ID, "Could not choose a folder", { description: `${errorText(error)} No export was created.` }); return }
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
    if (!operation) { dismissOperationToast(TRANSFER_TOAST_ID); return }
    const isExport = operation.operation === "backup"

    if (operation.kind === "running") {
      const title = isExport
        ? (checkpointRef.current ? `Exporting checkpoint “${checkpointRef.current}”` : `Exporting ${operation.archive.sandboxes.join(", ") || "sandbox"}`)
        : `Importing ${operation.targetName ?? "sandbox"}`
      const phase = operation.phases.find((entry) => entry.tone === "running") ?? operation.phases.at(-1)
      const onCancel = () => backupRef.current.actions.cancelOperation()
      showOperationProgress(TRANSFER_TOAST_ID, {
        title,
        step: phase ? (phase.detail || phase.title) : undefined,
        steps: operation.phases.map((entry) => ({ label: entry.title, state: stepState[entry.tone] })),
        progress: operation.indeterminate ? null : operation.progress / 100,
        cancel: operation.canCancel === false ? undefined : isExport
          ? { onCancel, confirm: { prompt: "Stop exporting? The incomplete file is removed.", confirmLabel: "Stop", keepLabel: "Keep going" } }
          : { onCancel, confirm: { prompt: "Remove the incomplete sandbox?", confirmLabel: "Remove", keepLabel: "Keep going" } },
      })
      return
    }

    const dismiss = () => backupRef.current.actions.dismissOperation()

    if (operation.outcome === "success") {
      const archive = operation.archive
      const title = isExport ? (checkpointRef.current ? "Checkpoint exported" : "Exported") : `Imported ${operation.targetName ?? archive.sandboxes[0] ?? "sandbox"}`
      const action = isExport
        ? { label: revealLabel(), onClick: () => {
            backupRef.current.actions.revealArchive(archive).catch((error) => showActionFailure("Could not reveal the export", errorText(error)))
          } }
        : (() => {
            const name = operation.targetName
            const match = name ? optionsRef.current.source.workspaces.find(({ machine, computer }) => !computer && machine.name === name) : undefined
            const open = optionsRef.current.openSandbox
            return match && open ? { label: "Open", onClick: () => open(match.machine.id) } : undefined
          })()
      showOperationSuccess(TRANSFER_TOAST_ID, title, { description: isExport ? `${archive.name} · ${archive.size}` : "Stopped and verified.", action, sandbox: isExport ? undefined : operation.targetName ?? archive.sandboxes[0], onDismiss: dismiss })
      return
    }

    if (operation.outcome === "cancelled") {
      showOperationNotice(TRANSFER_TOAST_ID, operation.title, { description: operation.message, onDismiss: dismiss })
      return
    }

    // failed or restart-required: persistent, actionable.
    const description = <div className="grid gap-1"><p>{operation.message}</p>{operation.detail && <p className="text-muted-foreground">{operation.detail}</p>}</div>
    const retry = operation.outcome === "restart-required"
      ? { label: "Retry start", onClick: () => backupRef.current.actions.retryStart(operation.runningNames[0]) }
      : retryRef.current
      ? { label: "Retry", onClick: () => retryRef.current?.() }
      : undefined
    showOperationFailure(TRANSFER_TOAST_ID, operation.title, { description, action: retry, onDismiss: dismiss, tone: operation.outcome === "restart-required" ? "warning" : "error" })
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [backup.state.operation])

  const importPopover = (anchor: ReactNode) => <ImportPopover
    anchor={anchor}
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
  />

  return { exportSandbox, beginImport, importPopover }
}
