import { useId, type ReactNode } from "react"

import { FormPopover } from "@/components/confirm-popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { BackupArchive } from "@/features/application/model/backup-source"
import { validateSandboxName } from "@/features/onboarding/model/machine-configuration"

export type ImportReview =
  | { kind: "checking" }
  | { kind: "invalid"; reason: string }
  | { kind: "review"; archive: BackupArchive; sourceName: string; newName: string }

/** Import review popover anchored to the sandbox list's Add button: shows the export file summary,
 * picks a source sandbox when several are present, and names the new sandbox. */
export function ImportPopover({ source, review, anchor, onReview, onImport, onClose, onRetry }: {
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
    ? <Progress value={null} aria-label="Import validation progress" />
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
