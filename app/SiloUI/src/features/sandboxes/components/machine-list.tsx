import { ActionsMenu, type MenuAction, type MenuPopovers } from "@/components/actions-menu"
import { useEffect, useEffectEvent, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react"
import { CopyPlus, GripVertical, Pencil, Plus, Trash2 } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { ConfirmPopover } from "@/components/confirm-popover"
import { ListHeader, listHeadingClassName } from "@/components/list-header"
import { Button } from "@/components/ui/button"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { configurationRequest } from "@/features/onboarding/model/machine-configuration"
import { MachineEditor } from "@/features/sandboxes/components/machine-editor"
import { useMachineEditing } from "@/features/sandboxes/model/use-machine-editing"
import { SandboxAction, SandboxList, SandboxListItem, SandboxListRow, type SandboxIconState, type SandboxRowTone } from "@/features/sandboxes/components/sandbox-list"
import { machineSummary } from "@/features/sandboxes/model/machine-summary"
import { deleteSandboxDescription, deleteSandboxTitle } from "@/features/sandboxes/model/delete-sandbox-copy"
import { DeleteSandboxBody, type DeleteSandboxDetails } from "@/features/sandboxes/components/delete-sandbox-confirmation"
import { sandboxEditMenu } from "@/features/sandboxes/model/sandbox-edit-menu"
import type { HostCapacity } from "@/features/sandboxes/model/machine-limits"
import type { MachineEditorDraft } from "@/features/onboarding/model/onboarding-draft"

export interface MachineRowPresentation {
  expandedContent?: ReactNode
  menuActions?: MenuAction[]
  /** Popovers opened by `menuActions` entries with a matching `popover` key, anchored to the ⋯ button. */
  popovers?: MenuPopovers
  kindBadge?: ReactNode
  badge?: ReactNode
  detail?: ReactNode
  detailClassName?: string
  icon?: ReactNode
  iconState?: SandboxIconState
  actions?: ReactNode
  actionsClassName?: string
  tone?: SandboxRowTone
  busy?: boolean
  /** Disables the row's mutating controls (reorder, ⋯ menu) while work runs. Opening the
   * sandbox's page stays available so its progress and errors remain reachable. */
  suppressInteractions?: boolean
  /** False when the row has no page to open yet (a sandbox that is still being created). */
  openable?: boolean
  /** What the Delete dialog states (checkpoints, size) and offers (Export, then delete). */
  deleteDetails?: DeleteSandboxDetails
}

interface MachineListProps {
  machines: readonly SetupMachineConfiguration[]
  computers?: readonly { id: string; name: string; connected: boolean }[]
  getComputerId?: (machine: SetupMachineConfiguration) => string | undefined
  onCommitMachine?: (machine: SetupMachineConfiguration, original: SetupMachineConfiguration | undefined, computerId: string, baseline?: SetupMachineConfiguration[]) => Promise<void>
  onDeleteMachine?: (machine: SetupMachineConfiguration, baseline?: SetupMachineConfiguration[]) => Promise<void>
  onConnectComputer?: () => void
  onImportSandbox?: () => void
  /** Wraps the Add button so an import review popover can anchor to it. */
  importPopover?: (addButton: ReactNode) => ReactNode
  onMachinesChange: (machines: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[]) => Promise<void> | void
  getRowPresentation?: (machine: SetupMachineConfiguration) => MachineRowPresentation
  sortPriority?: (machine: SetupMachineConfiguration) => number
  /** This computer's saved position of a row, lower first; rows without one follow in `machines` order. */
  orderRank?: (machine: SetupMachineConfiguration) => number | undefined
  /** Saves a reordered list (every row, local and remote, by id) instead of changing the
   * sandbox configuration. Without it, only local rows reorder, through `onMachinesChange`. */
  onReorder?: (machineIds: string[]) => void
  newSandboxRequest?: number
  onNewSandboxRequestHandled?: (id: number) => void
  /** Opens the sandbox's detail page when its row body is activated. */
  onOpenMachine?: (machine: SetupMachineConfiguration) => void
  /** Runs Duplicate against a machine on behalf of its detail page (which opens the list editor). */
  machineActionRequest?: { token: number; machineId: string; action: "duplicate" }
  onMachineActionHandled?: (token: number) => void
  interactionDisabled?: boolean
  summary?: ReactNode
  footer?: ReactNode
  initialEditorDraft?: MachineEditorDraft | null
  onEditorDraftChange?: (editor: MachineEditorDraft | null) => void
  isMachineCreated?: (machine: SetupMachineConfiguration) => boolean
  isMachineRunning?: (machine: SetupMachineConfiguration) => boolean
  validateOperation?: (machine: SetupMachineConfiguration, isNew: boolean, computerId?: string) => string | undefined
  /** The CPUs and memory of a computer ("" is this one), when known: fits new-sandbox defaults and presets, and rejects ceilings above it. */
  getHostCapacity?: (computerId: string) => HostCapacity | undefined
  /** Why a sandbox cannot be edited or deleted now (it is starting or stopping), if so. */
  getMachineBusyReason?: (machine: SetupMachineConfiguration) => string | undefined
  /** Keeps an open editor across navigation within a `MachineEditorDraftsProvider`. */
  editorDraftKey?: string
}

export function MachineList({ computers, getComputerId, onCommitMachine, onDeleteMachine, onConnectComputer, onImportSandbox, importPopover, machines, onMachinesChange, getRowPresentation, sortPriority, orderRank, onReorder, interactionDisabled: interactionDisabledProp = false, newSandboxRequest, onNewSandboxRequestHandled, onOpenMachine, machineActionRequest, onMachineActionHandled, summary, footer, initialEditorDraft = null, onEditorDraftChange, validateOperation, isMachineCreated, isMachineRunning, getHostCapacity, getMachineBusyReason, editorDraftKey }: MachineListProps) {
  const {
    computerId, setComputerId,
    committing,
    interactionDisabled,
    saveBlockedReason,
    editor, setEditor,
    editorBaseline, editorConflict, editorReview, editorResetToken,
    editorFocusRequest, setEditorFocusRequest,
    baselineRef,
    captureBaseline, beginOperation, dispatchChange,
    startEdit, startAdd, startDuplicate, save, remove, reviewConflict, deleteWithNotice,
  } = useMachineEditing({ machines, getComputerId, onCommitMachine, onDeleteMachine, onMachinesChange, validateOperation, isMachineRunning, onEditorDraftChange, initialEditorDraft, interactionDisabled: interactionDisabledProp, getHostCapacity, getMachineBusyReason, draftKey: editorDraftKey })

  const [addOpen, setAddOpen] = useState(false)
  const addSelected = useRef<"editor" | "external" | null>(null)
  const [draggedID, setDraggedID] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")

  // Rows in this computer's saved order; rows it has not placed yet keep their place after them.
  const orderedMachines = useMemo(() => {
    if (!orderRank) return machines
    return [...machines]
      .map((machine, index) => ({ machine, index, rank: orderRank(machine) ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ machine }) => machine)
  }, [machines, orderRank])

  const displayMachines = useMemo(() => {
    // Inject the open editor's draft whenever no live machine carries its id: a new/
    // duplicated machine, or one deleted elsewhere while its editor stayed open (so the
    // conflict notice remains visible instead of the row vanishing).
    const detached = editor ? !machines.some(({ id }) => id === editor.draft.id) : false
    if (!sortPriority) {
      const next = [...orderedMachines]
      if (editor && detached) next.splice(editor.insertAt, 0, editor.draft)
      return next
    }

    const next = [...orderedMachines]
      .map((machine, index) => ({ machine, index }))
      .sort((a, b) => sortPriority(a.machine) - sortPriority(b.machine) || a.index - b.index)
      .map(({ machine }) => machine)
    if (editor && detached) {
      const sourceIndex = editor.displayAfterID ? next.findIndex(({ id }) => id === editor.displayAfterID) : -1
      next.splice(sourceIndex >= 0 ? sourceIndex + 1 : next.length, 0, editor.draft)
    }
    return next
  }, [editor, machines, orderedMachines, sortPriority])

  const consumedNewRequest = useRef(0)
  const openRequestedVM = useEffectEvent((id: number) => {
    if (!interactionDisabled) {
      if (editor) setEditorFocusRequest(id)
      else startAdd("vm")
    }
    onNewSandboxRequestHandled?.(id)
  })
  useEffect(() => {
    if (!newSandboxRequest || consumedNewRequest.current === newSandboxRequest) return
    consumedNewRequest.current = newSandboxRequest
    openRequestedVM(newSandboxRequest)
  }, [newSandboxRequest])

  const consumedMachineAction = useRef(0)
  const runMachineAction = useEffectEvent((request: NonNullable<MachineListProps["machineActionRequest"]>) => {
    const machine = machines.find(({ id }) => id === request.machineId)
    if (machine && !interactionDisabled) startDuplicate(machine)
    onMachineActionHandled?.(request.token)
  })
  useEffect(() => {
    if (!machineActionRequest || consumedMachineAction.current === machineActionRequest.token) return
    consumedMachineAction.current = machineActionRequest.token
    runMachineAction(machineActionRequest)
  }, [machineActionRequest])

  const isRemote = (machine: SetupMachineConfiguration) => Boolean(getComputerId?.(machine))
  // With `onReorder`, this computer saves its own order of every row. Otherwise only local rows
  // reorder (their order is part of this computer's configuration) and positions count them only.
  const reorderable = (machine: SetupMachineConfiguration) => Boolean(onReorder) || !isRemote(machine)
  const orderable = displayMachines.filter((machine) => reorderable(machine) && machines.some(({ id }) => id === machine.id))
  // A keyboard move waits for the source to publish the previous one, so rapid presses
  // never recompute from the stale `machines` the first move started from.
  const reorderPending = useRef(false)
  useEffect(() => { reorderPending.current = false }, [machines])

  function reorder(id: string, targetIndex: number) {
    if (interactionDisabled || editor || reorderPending.current) return
    // Reorder against the order captured when the drag/keyboard move began, so the change
    // carries that order as `expectedOrder` and does not fold in concurrent edits. A saved
    // display order has no configuration to conflict with, so it reorders the current rows.
    const base = onReorder ? [...orderedMachines] : (baselineRef.current ?? [...machines]).filter((machine) => !isRemote(machine))
    const reorderBaseline = baselineRef.current ? base : undefined
    const from = orderable.findIndex((machine) => machine.id === id)
    const boundedTarget = Math.max(0, Math.min(targetIndex, orderable.length - 1))
    if (from < 0 || from === boundedTarget) return
    beginOperation()
    const moved = orderable[from]
    const target = orderable[boundedTarget]
    let updated: SetupMachineConfiguration[]

    if (sortPriority) {
      const priority = sortPriority(moved)
      if (sortPriority(target) !== priority) {
        setAnnouncement(`${moved.name} can only be reordered within its status group.`)
        return
      }
      const bucket = base.filter((machine) => sortPriority(machine) === priority)
      const bucketFrom = bucket.findIndex((machine) => machine.id === moved.id)
      const bucketTarget = bucket.findIndex((machine) => machine.id === target.id)
      if (bucketFrom < 0 || bucketTarget < 0) return
      const [bucketMoved] = bucket.splice(bucketFrom, 1)
      bucket.splice(bucketTarget, 0, bucketMoved)
      let bucketIndex = 0
      updated = base.map((machine) => sortPriority(machine) === priority ? bucket[bucketIndex++] : machine)
    } else {
      updated = [...base]
      const configuredFrom = updated.findIndex((machine) => machine.id === id)
      const configuredTarget = updated.findIndex((machine) => machine.id === target.id)
      if (configuredFrom < 0 || configuredTarget < 0) return
      const [configuredMoved] = updated.splice(configuredFrom, 1)
      updated.splice(configuredTarget, 0, configuredMoved)
    }

    if (onReorder) {
      onReorder(updated.map(({ id }) => id))
      setAnnouncement(`${moved.name} moved to position ${boundedTarget + 1} of ${orderable.length}.`)
      return
    }
    const pending = dispatchChange(configurationRequest(updated).machines, reorderBaseline)
    if (pending) {
      reorderPending.current = true
      void pending.finally(() => { reorderPending.current = false })
    }
    setAnnouncement(`${moved.name} moved to position ${boundedTarget + 1} of ${orderable.length}.`)
  }

  function handleReorderKey(event: KeyboardEvent<HTMLElement>, machine: SetupMachineConfiguration) {
    if (interactionDisabled || editor) return
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    if (reorderPending.current) return
    captureBaseline()
    const from = orderable.findIndex(({ id }) => id === machine.id)
    reorder(machine.id, from + (event.key === "ArrowUp" ? -1 : 1))
  }

  function drop(event: DragEvent, target: SetupMachineConfiguration, rowDisabled = false) {
    event.preventDefault()
    const targetIndex = orderable.findIndex(({ id }) => id === target.id)
    const id = draggedID || event.dataTransfer.getData("text/plain")
    setDraggedID(null)
    if (interactionDisabled || rowDisabled || targetIndex < 0 || !id) return
    reorder(id, targetIndex)
  }

  const sandboxCount = machines.filter(machine => machine.kind === "vm").length
  const remoteCount = machines.filter(machine => machine.kind === "vm" && getComputerId?.(machine)).length
  const sshHostCount = machines.length - sandboxCount

  return (
    <>
      <div aria-labelledby="machine-list-heading" className="flex h-full min-h-0 flex-col">
        <ListHeader
          heading={<h3 id="machine-list-heading" className={listHeadingClassName}>Sandboxes</h3>}
          subtitle={summary ?? <>{sandboxCount} {sandboxCount === 1 ? "sandbox" : "sandboxes"} · {sandboxCount - remoteCount} on this computer · {remoteCount} on other computers · {sshHostCount} {sshHostCount === 1 ? "SSH host" : "SSH hosts"}</>}
          actions={(importPopover ?? ((node: ReactNode) => node))(<DropdownMenu.Root open={addOpen} onOpenChange={setAddOpen}>
            <DropdownMenu.Trigger asChild>
              <Button type="button" variant="outline" size="xs" disabled={interactionDisabled}>
                <Plus aria-hidden="true" data-icon="inline-start" /> Add
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content aria-label="Add sandbox" aria-labelledby={undefined} align="end" sideOffset={4} onCloseAutoFocus={event => {
              // A selection hands focus to the editor or dialog it opens.
              if (addSelected.current) {
                event.preventDefault()
                if (addSelected.current === "editor") setEditorFocusRequest(request => request + 1)
                addSelected.current = null
              }
            }} className="silo-portal z-50 grid w-48 gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
              <DropdownMenu.Item className="rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none" onSelect={() => { addSelected.current = "editor"; startAdd("vm") }}>New sandbox</DropdownMenu.Item>
              <DropdownMenu.Item className="rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none" onSelect={() => { addSelected.current = onConnectComputer ? "external" : "editor"; if (onConnectComputer) onConnectComputer(); else startAdd("ssh") }}>{onConnectComputer ? "Connect computer…" : "Connect an SSH host…"}</DropdownMenu.Item>
              {onImportSandbox && <DropdownMenu.Item className="rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none" onSelect={() => { addSelected.current = "external"; onImportSandbox() }}>Import sandbox…</DropdownMenu.Item>}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>)}
        />

        <SandboxList label="Configured sandboxes" className="max-h-full min-h-0" data-testid="machine-list">
            {displayMachines.map((machine) => {
              const isEditing = editor?.draft.id === machine.id
              const runningVM = machine.kind === "vm" && Boolean(isMachineRunning?.(machine))
              // Starting or stopping VMs can be neither edited nor deleted until they settle.
              const busyReason = getMachineBusyReason?.(machine)
              const deleteTooltip = runningVM ? "Stop the sandbox before deleting it." : busyReason
              const presentation = getRowPresentation?.(machine)
              const rowInteractionsDisabled = interactionDisabled || Boolean(presentation?.suppressInteractions)
              const reorderDisabled = rowInteractionsDisabled || Boolean(editor)
              const computerName = computers?.find(computer => computer.id === getComputerId?.(machine))?.name
              const deletionName = computerName ? `${machine.name} on ${computerName}` : machine.name
              return (
                <SandboxListItem
                  key={machine.id}
                  data-machine-id={machine.id}
                  data-sandbox-name={machine.name}
                  aria-busy={presentation?.busy || undefined}
                  className="min-w-0 bg-background"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => drop(event, machine, Boolean(presentation?.suppressInteractions))}
                >
                  {isEditing && editor ? (
                    <MachineEditor key={`${editor.draft.id}:${editorResetToken}`} saving={committing} blockedReason={saveBlockedReason} editorHeader={computers && editor.draft.kind === "vm" ? <label className="grid gap-1 text-[11px] text-muted-foreground">Run on<select aria-label="Run on" className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground" value={computerId} disabled={Boolean(editor.originalID) || committing} onChange={event => setComputerId(event.target.value)}><option value="">This computer</option>{computers.map(computer => <option key={computer.id} value={computer.id} disabled={!computer.connected}>{computer.name}{!computer.connected ? " (offline)" : ""}</option>)}</select></label> : undefined} focusRequest={editorFocusRequest} capacity={getHostCapacity?.(computerId)} computerName={computers?.find(computer => computer.id === computerId)?.name} computerId={computerId} created={Boolean(editor.originalID && isMachineCreated?.(machine))} running={Boolean(editor.originalID && machine.kind === "vm" && isMachineRunning?.(machine))} editor={editor} baselineMachine={editorBaseline ?? undefined} conflict={editorConflict} review={editorReview} machines={getComputerId ? machines.filter(machine => (getComputerId(machine) ?? "") === computerId) : machines} onCancel={() => setEditor(null)} onSave={save} onDraftChange={(draft) => setEditor({ ...editor, draft })} onReview={reviewConflict} onDiscard={() => setEditor(null)} />
                  ) : (
                    <SandboxListRow
                      name={machine.name}
                      kind={machine.kind}
                      onOpen={onOpenMachine && presentation?.openable !== false ? () => onOpenMachine(machine) : undefined}
                      remote={Boolean(getComputerId?.(machine)) || machine.kind === "ssh"}
                      kindBadge={presentation?.kindBadge}
                      badge={presentation?.badge}
                      iconState={presentation?.iconState}
                      icon={presentation?.icon}
                      tone={presentation?.tone}
                      detail={presentation?.detail ?? machineSummary(machine)}
                      detailClassName={presentation?.detailClassName}
                      leading={!reorderable(machine) ? <span aria-hidden="true" className="size-7 shrink-0" /> : <span
                        role="button"
                        tabIndex={reorderDisabled ? -1 : 0}
                        draggable={!reorderDisabled}
                        aria-label={`Reorder ${machine.name}`}
                        aria-disabled={reorderDisabled || undefined}
                        className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing aria-disabled:cursor-default aria-disabled:opacity-40"
                        onKeyDown={(event) => { if (!reorderDisabled) handleReorderKey(event, machine) }}
                        onDragStart={(event) => {
                          if (reorderDisabled) { event.preventDefault(); return }
                          beginOperation()
                          captureBaseline()
                          setDraggedID(machine.id)
                          event.dataTransfer.effectAllowed = "move"
                          event.dataTransfer.setData("text/plain", machine.id)
                        }}
                        onDragEnd={() => setDraggedID(null)}
                      >
                        <GripVertical className="size-4" aria-hidden="true" />
                      </span>}
                      actions={presentation?.actions || presentation?.menuActions ? <>{presentation?.actions}{presentation?.menuActions && <ActionsMenu label={`More actions for ${machine.name}`} popovers={{
                        ...presentation.popovers,
                        delete: close => <DeleteSandboxBody
                          kind={machine.kind}
                          displayName={deletionName}
                          details={presentation.deleteDetails}
                          onClose={close}
                          onDelete={() => deleteWithNotice(machine)}
                        />,
                      }} items={[
                        ...presentation.menuActions,
                        // The menu stays open to navigation while work runs; its items that
                        // change the sandbox follow the row's interaction lock.
                        ...sandboxEditMenu({
                          machine,
                          displayName: deletionName,
                          disabled: rowInteractionsDisabled,
                          busyReason,
                          created: Boolean(isMachineCreated?.(machine)),
                          running: runningVM,
                          separatorBefore: presentation.menuActions.length > 0,
                          onEdit: () => startEdit(machine),
                          onDuplicate: () => startDuplicate(machine),
                          onAddDesktop: (vm) => {
                            beginOperation()
                            captureBaseline()
                            void save({ ...vm, desktop: { startWithSandbox: true } }, machine.id, getComputerId?.(machine) ?? "")
                          },
                        }),
                      ]} />}</> : undefined}
                      actionsClassName={presentation?.actionsClassName}
                      hoverActions={presentation?.suppressInteractions || presentation?.menuActions ? undefined : <>
                        <SandboxAction label={`Edit ${machine.name}`} tooltip={busyReason} disabled={interactionDisabled || Boolean(busyReason)} onClick={() => startEdit(machine)}><Pencil /></SandboxAction>
                        <SandboxAction tooltip={machine.kind === "vm" ? "Create a new empty sandbox with the same settings." : "Create a new SSH host connection with the same settings."} label={`Duplicate settings for ${machine.name}`} disabled={interactionDisabled} onClick={() => startDuplicate(machine)}>
                          <CopyPlus />
                        </SandboxAction>
                        <ConfirmPopover align="end" tone="destructive" title={deleteSandboxTitle(deletionName)} description={deleteSandboxDescription(machine.kind)} confirmLabel="Delete permanently" tooltip={deleteTooltip ?? `Delete ${deletionName}`} onConfirm={() => remove(machine)}>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Delete ${deletionName}`} disabled={interactionDisabled || runningVM || Boolean(busyReason)}>
                            <Trash2 />
                          </Button>
                        </ConfirmPopover>
                      </>}
                    />
                  )}
                  {!isEditing && presentation?.expandedContent}
                </SandboxListItem>
              )
            })}
        </SandboxList>
        {footer && <div className="mt-3 shrink-0">{footer}</div>}
        <p className="sr-only" aria-live="polite">{announcement}</p>
      </div>
    </>
  )
}
