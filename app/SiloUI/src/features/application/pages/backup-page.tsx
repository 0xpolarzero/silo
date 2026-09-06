import { useEffect, useRef, useState } from "react"
import { Archive, Check, Info, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react"

import { DisclosureHeader } from "@/components/disclosure-header"
import { ListCard, ListRow, ListRowDetails, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { BackupArchive, BackupController, BackupOperationKind } from "@/features/application/model/backup-source"

type Review =
  | { kind: "idle" }
  | { kind: "backup-review" }
  | { kind: "restore-review"; archive: BackupArchive; confirmation: string }
  | { kind: "invalid-archive"; archive: BackupArchive }

export interface BackupPageProps {
  source: ApplicationSource
  backup: BackupController
  onBusyChange?: (busy: boolean) => void
}

export function BackupPage(props: BackupPageProps) {
  return <BackupPageContent key={props.backup.state.snapshotId} {...props} />
}

function BackupPageContent({ source, backup, onBusyChange }: BackupPageProps) {
  const [destination, setDestination] = useState(source.backup.destination)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [review, setReview] = useState<Review>({ kind: "idle" })
  const [expandedArchive, setExpandedArchive] = useState<string | null>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const archiveInput = useRef<HTMLInputElement>(null)
  const backupButton = useRef<HTMLButtonElement>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  const { archives, operation, requiredSpaceGB } = backup.state
  const flow = operation ?? review
  const busy = flow.kind === "running"
  const controlsDisabled = busy || pickingFolder
  const localSandboxes = source.workspaces.filter(({ machine }) => machine.kind === "vm")
  const runningNames = localSandboxes.filter(({ state }) => state === "running").map(({ machine }) => machine.name)
  const backupExpanded = flow.kind === "backup-review" || ((flow.kind === "running" || flow.kind === "result") && flow.operation === "backup")

  useEffect(() => {
    onBusyChange?.(busy)
    return () => { if (busy) onBusyChange?.(false) }
  }, [busy, onBusyChange])

  function showReview(next: Review) {
    backup.actions.dismissOperation()
    setReview(next)
  }

  function closeFlow() {
    showReview({ kind: "idle" })
    if (backupExpanded) backupButton.current?.focus()
    else restoreButton.current?.focus()
  }

  function startBackup() {
    if (!destination || localSandboxes.length === 0) return
    setReview({ kind: "idle" })
    backup.actions.startBackup(destination)
  }

  async function pickDestination() {
    setPickerError(null)
    const pickerWindow = window as Window & {
      showDirectoryPicker?: (options: { id: string; mode: "read" }) => Promise<FileSystemDirectoryHandle>
    }
    if (!pickerWindow.showDirectoryPicker) {
      folderInput.current?.click()
      return
    }
    setPickingFolder(true)
    try {
      // The selected folder remains a draft until backup is confirmed.
      const folder = await pickerWindow.showDirectoryPicker({ id: "silo-backup-destination", mode: "read" })
      setDestination(folder.name)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setPickerError("Could not open the folder picker. Try again.")
      }
    } finally {
      setPickingFolder(false)
    }
  }

  function reviewArchive(selection: BackupArchive | File) {
    const { archive, valid } = backup.actions.inspectArchive(selection)
    showReview(valid ? { kind: "restore-review", archive, confirmation: "" } : { kind: "invalid-archive", archive })
  }

  function pickArchive() {
    setPickerError(null)
    archiveInput.current?.click()
  }

  function operationPanel(operation: BackupOperationKind) {
    if ((flow.kind !== "running" && flow.kind !== "result") || flow.operation !== operation) return null
    if (flow.kind === "running") {
      const step = flow.progress
      return <ListRowDetails label={operation === "backup" ? "Backup in progress" : "Restore in progress"}>
        <div className="flex items-start gap-2" role="status">
          <LoaderCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground" />
          <div className="min-w-0 flex-1"><p className="font-medium">{step.title}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{step.detail}</p></div>
          <span className="text-[10px] tabular-nums text-muted-foreground">{step.progress}%</span>
        </div>
        <Progress value={step.progress} aria-label={operation === "backup" ? "Backup progress" : "Restore progress"} />
        <p className="text-[10px] text-muted-foreground">Keep Silo open until this finishes.</p>
      </ListRowDetails>
    }
    const failed = flow.outcome === "failed"
    return <ListRowDetails label={operation === "backup" ? "Backup result" : "Restore result"}>
      <div role={failed ? "alert" : "status"} className="flex items-start gap-2">
        {failed ? <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{operation === "backup" ? "Backup" : "Restore"} {failed ? "failed" : "completed"}</p>
          <p className="text-[11px] text-muted-foreground">{flow.message}</p>
          {!failed && <p className="break-all text-[10px] text-muted-foreground">{[flow.archive.destination, flow.archive.name].filter(Boolean).join(" / ")}</p>}
          {flow.outcome === "restart-required" && <p className="text-[11px] text-amber-700 dark:text-amber-400">Restart {flow.runningNames.join(", ")} to return to the previous running state. Your backup is valid.</p>}
        </div>
      </div>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={closeFlow}>{failed ? "Dismiss" : "Done"}</Button>
        {failed && <Button variant="outline" size="xs" onClick={() => operation === "backup" ? showReview({ kind: "backup-review" }) : pickArchive()}>{operation === "backup" ? "Review and retry" : "Choose another archive"}</Button>}
      </div>
    </ListRowDetails>
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-5 sm:px-6 sm:py-6" onKeyDown={(event) => {
        if (event.key === "Escape" && flow.kind !== "idle" && !busy) { event.preventDefault(); closeFlow() }
      }}>
        <input
          ref={(element) => { folderInput.current = element; if (element) element.webkitdirectory = true }}
          type="file" hidden aria-label="Backup destination folder" disabled={controlsDisabled}
          onChange={(event) => {
            const input = event.currentTarget
            const name = input.webkitEntries?.[0]?.name || input.files?.[0]?.webkitRelativePath.split("/")[0]
            if (name) setDestination(name)
            input.value = ""
          }}
        />
        <input
          ref={archiveInput} type="file" accept=".silo-backup" hidden aria-label="Backup archive file" disabled={controlsDisabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (!file) return
            if (!file.name.endsWith(".silo-backup")) {
              setPickerError("Choose a .silo-backup archive.")
              return
            }
            setPickerError(null)
            reviewArchive(file)
          }}
        />
        {pickerError && <p role="alert" className="text-[11px] text-destructive">{pickerError}</p>}
        <section className="grid gap-2">
          <h2 className="text-xs font-medium">Backup</h2>
          <ListCard>
          <ul className="divide-y divide-border" aria-label="Backup controls">
            <li>
              <ListRow
                className="hover:bg-muted/35 focus-within:bg-muted/35"
                icon={<ListRowIcon aria-hidden="true"><Archive className="size-3.5" /></ListRowIcon>}
                title={<>
                  <h3 className="truncate">Create backup</h3>
                  <Tooltip>
                    <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="size-4 text-muted-foreground" aria-label="What a backup includes"><Info aria-hidden="true" /></Button></TooltipTrigger>
                    <TooltipContent>Includes sandbox code, VM state, databases, Docker data, and guest-side credentials. macOS Keychain credentials are excluded.</TooltipContent>
                  </Tooltip>
                </>}
                detail={<span title={destination || undefined}>{destination || "Select a destination to save your backups."}</span>}
                actions={<div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="xs" aria-label="Select destination" disabled={controlsDisabled} onClick={pickDestination}>Select destination…</Button>
                  <Button ref={backupButton} type="button" variant="outline" size="xs" disabled={controlsDisabled || !destination || localSandboxes.length === 0} aria-expanded={backupExpanded} aria-controls="backup-details" onClick={() => showReview({ kind: "backup-review" })}>Back up</Button>
                </div>}
              />
              <div id="backup-details">
                {flow.kind === "backup-review" && <ListRowDetails label="Review backup">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
                    <dt className="text-muted-foreground">Destination</dt><dd className="break-all">{destination}</dd>
                    <dt className="text-muted-foreground">Space</dt><dd>About {requiredSpaceGB} GB required</dd>
                    <dt className="text-muted-foreground">Sandboxes</dt><dd>{localSandboxes.map(({ machine }) => machine.name).join(", ")}</dd>
                  </dl>
                  <p className="text-[11px] text-muted-foreground">{runningNames.length > 0 ? `${runningNames.join(", ")} will stop briefly and restart after the backup. Stopped sandboxes will stay stopped.` : "All sandboxes are stopped and will stay stopped after the backup."}</p>
                  <div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={closeFlow}>Cancel</Button><Button autoFocus variant="outline" size="xs" onClick={startBackup}>Start backup</Button></div>
                </ListRowDetails>}
                {operationPanel("backup")}
              </div>
            </li>
            <li>
              <ListRow
                className="hover:bg-muted/35 focus-within:bg-muted/35"
                icon={<ListRowIcon aria-hidden="true"><RotateCcw className="size-3.5" /></ListRowIcon>}
                title={<h3 className="truncate">Restore archive</h3>}
                detail="Replaces all sandbox state and leaves sandboxes stopped."
                detailClassName="whitespace-normal"
                actions={<Button ref={restoreButton} type="button" variant="outline" size="xs" disabled={controlsDisabled} onClick={pickArchive}>Choose archive…</Button>}
              />
              <div id="restore-details">
                {flow.kind === "invalid-archive" && <ListRowDetails label="Archive validation">
                  <div role="alert" className="space-y-1"><p className="font-medium text-destructive">Checksum mismatch</p><p className="text-[11px] text-muted-foreground">This archive is incomplete or damaged. Choose another copy. No sandbox data has changed.</p></div>
                  <div className="flex justify-end gap-1"><Button variant="ghost" size="xs" onClick={closeFlow}>Cancel</Button><Button variant="outline" size="xs" onClick={() => pickArchive()}>Choose another archive</Button></div>
                </ListRowDetails>}
                {flow.kind === "restore-review" && <ListRowDetails label="Review restore">
                  <div className="space-y-1"><p className="break-all text-[11px] font-medium">{flow.archive.name}</p><p className="text-[10px] text-muted-foreground">{flow.archive.completedLabel} · {flow.archive.size} · {flow.archive.sandboxes.length} sandboxes</p><p className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"><Check aria-hidden="true" className="size-3" />Checksum verified</p></div>
                  <p className="text-[11px] text-muted-foreground">Replaces current sandbox data with {flow.archive.sandboxes.join(", ")} from this archive. Changes since the backup will be lost. All restored sandboxes will stay stopped.</p>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <label className="grid gap-1.5 text-[11px]">Type RESTORE to confirm<Input autoFocus autoComplete="off" spellCheck={false} className="h-7 w-44 rounded-md text-xs md:text-xs" value={flow.confirmation} onChange={(event) => setReview({ ...flow, confirmation: event.target.value })} /></label>
                    <div className="flex gap-1"><Button variant="ghost" size="xs" onClick={closeFlow}>Cancel</Button><Button variant="destructive" size="xs" disabled={flow.confirmation !== "RESTORE"} onClick={() => {
                      if (flow.confirmation === "RESTORE") {
                        setReview({ kind: "idle" })
                        backup.actions.startRestore(flow.archive)
                      }
                    }}>Restore backup</Button></div>
                  </div>
                </ListRowDetails>}
                {operationPanel("restore")}
              </div>
            </li>
          </ul>
          </ListCard>
        </section>
        <section className="grid gap-2" aria-labelledby="backup-history-heading">
          <h3 id="backup-history-heading" className="text-xs font-medium">Recent backups</h3>
          <ListCard>
          <ul className="divide-y divide-border" aria-label="Recent backups">
            {archives.length === 0 && <li><ListRow
              icon={<ListRowIcon aria-hidden="true"><Archive className="size-3.5" /></ListRowIcon>}
              title="No backups yet"
              detail="Completed backups will appear here."
            /></li>}
            {archives.map((archive) => <Collapsible key={archive.name} asChild open={expandedArchive === archive.name} onOpenChange={(open) => setExpandedArchive(open ? archive.name : null)}><li>
              <DisclosureHeader
                icon={<ListRowIcon className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" role="img" aria-label="Backup completed"><Check className="size-3.5" aria-hidden="true" /></ListRowIcon>}
                title={archive.name}
                detail={[archive.completedLabel, archive.size, `${archive.sandboxes.length} sandboxes`].filter(Boolean).join(" · ")}
                label={`Details for ${archive.name}`}
              />
              <CollapsibleContent className="collapsible-content-motion"><ListRowDetails label={`Archive details for ${archive.name}`}>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]"><dt className="text-muted-foreground">Location</dt><dd className="break-all">{archive.destination}</dd><dt className="text-muted-foreground">Sandboxes</dt><dd>{archive.sandboxes.join(", ")}</dd></dl>
                <div className="flex justify-end"><Button variant="outline" size="xs" disabled={controlsDisabled} onClick={() => reviewArchive(archive)}>Restore…</Button></div>
              </ListRowDetails></CollapsibleContent>
            </li></Collapsible>)}
          </ul>
          </ListCard>
        </section>
      </div>
    </TooltipProvider>
  )
}
