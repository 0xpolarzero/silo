import { ActionsMenu, type MenuAction, type MenuPopovers } from "@/components/actions-menu"
import { useEffect, useEffectEvent, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react"
import { CopyPlus, GripVertical, Monitor, Pencil, Plus, Trash2 } from "lucide-react"

import { ConfirmBody, ConfirmPopover } from "@/components/confirm-popover"
import { ListHeader, listHeadingClassName } from "@/components/list-header"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { configurationRequest } from "@/features/onboarding/model/machine-configuration"
import { MachineEditor } from "@/features/sandboxes/components/machine-editor"
import { useMachineEditing } from "@/features/sandboxes/model/use-machine-editing"
import { SandboxAction, SandboxList, SandboxListItem, SandboxListRow, type SandboxIconState, type SandboxRowTone } from "@/features/sandboxes/components/sandbox-list"
import { machineSummary } from "@/features/sandboxes/model/machine-summary"
import { deleteSandboxDescription } from "@/features/sandboxes/model/delete-sandbox-copy"
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
  suppressInteractions?: boolean
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
}

export function MachineList({ computers, getComputerId, onCommitMachine, onDeleteMachine, onConnectComputer, onImportSandbox, importPopover, machines, onMachinesChange, getRowPresentation, sortPriority, interactionDisabled: interactionDisabledProp = false, newSandboxRequest, onNewSandboxRequestHandled, onOpenMachine, machineActionRequest, onMachineActionHandled, summary, footer, initialEditorDraft = null, onEditorDraftChange, validateOperation, isMachineCreated, isMachineRunning }: MachineListProps) {
  const {
    computerId, setComputerId,
    committing,
    interactionDisabled,
    editor, setEditor,
    editorBaseline, editorConflict, editorResetToken,
    editorFocusRequest, setEditorFocusRequest,
    baselineRef,
    captureBaseline, beginOperation, dispatchChange,
    startEdit, startAdd, startDuplicate, save, remove, reviewConflict, deleteWithNotice,
  } = useMachineEditing({ machines, getComputerId, onCommitMachine, onDeleteMachine, onMachinesChange, validateOperation, isMachineRunning, onEditorDraftChange, initialEditorDraft, interactionDisabled: interactionDisabledProp })

  const [addOpen, setAddOpen] = useState(false)
  const [draggedID, setDraggedID] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")

  const displayMachines = useMemo(() => {
    // Inject the open editor's draft whenever no live machine carries its id: a new/
    // duplicated machine, or one deleted elsewhere while its editor stayed open (so the
    // conflict notice remains visible instead of the row vanishing).
    const detached = editor ? !machines.some(({ id }) => id === editor.draft.id) : false
    if (!sortPriority) {
      const next = [...machines]
      if (editor && detached) next.splice(editor.insertAt, 0, editor.draft)
      return next
    }

    const next = [...machines]
      .map((machine, index) => ({ machine, index }))
      .sort((a, b) => sortPriority(a.machine) - sortPriority(b.machine) || a.index - b.index)
      .map(({ machine }) => machine)
    if (editor && detached) {
      const sourceIndex = editor.displayAfterID ? next.findIndex(({ id }) => id === editor.displayAfterID) : -1
      next.splice(sourceIndex >= 0 ? sourceIndex + 1 : next.length, 0, editor.draft)
    }
    return next
  }, [editor, machines, sortPriority])

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

  function reorder(id: string, targetIndex: number) {
    if (interactionDisabled) return
    // Reorder against the order captured when the drag/keyboard move began, so the change
    // carries that order as `expectedOrder` and does not fold in concurrent edits.
    const base = baselineRef.current ?? [...machines]
    const reorderBaseline = baselineRef.current ? (getComputerId ? base.filter(machine => !getComputerId(machine)) : base) : undefined
    const displayed = displayMachines.filter((machine) => machines.some(({ id: configuredID }) => configuredID === machine.id))
    const from = displayed.findIndex((machine) => machine.id === id)
    const boundedTarget = Math.max(0, Math.min(targetIndex, displayed.length - 1))
    if (from < 0 || from === boundedTarget) return
    beginOperation()
    const moved = displayed[from]

    if (sortPriority) {
      const target = displayed[boundedTarget]
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
      const updated = base.map((machine) => sortPriority(machine) === priority ? bucket[bucketIndex++] : machine)
      dispatchChange(configurationRequestMachines(updated, getComputerId), reorderBaseline)
      setAnnouncement(`${moved.name} moved to position ${boundedTarget + 1} of ${displayed.length}.`)
      return
    }

    const updated = [...base]
    const configuredFrom = updated.findIndex((machine) => machine.id === id)
    if (configuredFrom < 0) return
    const [configuredMoved] = updated.splice(configuredFrom, 1)
    updated.splice(boundedTarget, 0, configuredMoved)
    dispatchChange(configurationRequestMachines(updated, getComputerId), reorderBaseline)
    setAnnouncement(`${moved.name} moved to position ${boundedTarget + 1} of ${displayed.length}.`)
  }

  function handleReorderKey(event: KeyboardEvent<HTMLElement>, machine: SetupMachineConfiguration, index: number) {
    if (interactionDisabled) return
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    captureBaseline()
    reorder(machine.id, index + (event.key === "ArrowUp" ? -1 : 1))
  }

  function drop(event: DragEvent, targetIndex: number, rowDisabled = false) {
    event.preventDefault()
    if (interactionDisabled || rowDisabled) return
    const id = draggedID || event.dataTransfer.getData("text/plain")
    if (id) reorder(id, targetIndex)
    setDraggedID(null)
  }

  const remoteCount = machines.filter(machine => getComputerId?.(machine) || machine.kind === "ssh").length

  return (
    <>
      <div aria-labelledby="machine-list-heading" className="flex h-full min-h-0 flex-col">
        <ListHeader
          heading={<h3 id="machine-list-heading" className={listHeadingClassName}>Sandboxes</h3>}
          subtitle={summary ?? <>{machines.length} {machines.length === 1 ? "sandbox" : "sandboxes"} · {machines.length - remoteCount} on this computer · {remoteCount} remote</>}
          actions={(importPopover ?? ((node: ReactNode) => node))(<Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="xs" aria-haspopup="menu" disabled={interactionDisabled} onClick={beginOperation}>
                <Plus aria-hidden="true" data-icon="inline-start" /> Add
              </Button>
            </PopoverTrigger>
            <PopoverContent role="menu" aria-label="Add sandbox" align="end" className="grid w-48 gap-1 p-1">
              <button type="button" role="menuitem" className="rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => { setAddOpen(false); startAdd("vm") }}>New sandbox</button>
              <button type="button" role="menuitem" className="rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => { if (onConnectComputer) { setAddOpen(false); onConnectComputer() } else { setAddOpen(false); startAdd("ssh") } }}>{onConnectComputer ? "Connect computer…" : "Connect a machine via SSH"}</button>
              {onImportSandbox && <button type="button" role="menuitem" className="rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => { setAddOpen(false); onImportSandbox() }}>Import sandbox…</button>}
            </PopoverContent>
          </Popover>)}
        />

        <SandboxList label="Configured sandboxes" className="max-h-full min-h-0" data-testid="machine-list">
            {displayMachines.map((machine, index) => {
              const isEditing = editor?.draft.id === machine.id
              const runningVM = machine.kind === "vm" && Boolean(isMachineRunning?.(machine))
              const deleteTooltip = runningVM ? "Stop the sandbox before deleting it." : undefined
              const presentation = getRowPresentation?.(machine)
              const rowInteractionsDisabled = interactionDisabled || Boolean(presentation?.suppressInteractions)
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
                  onDrop={(event) => drop(event, index, Boolean(presentation?.suppressInteractions))}
                >
                  {isEditing && editor ? (
                    <MachineEditor key={`${editor.draft.id}:${editorResetToken}`} saving={committing} editorHeader={computers && editor.draft.kind === "vm" ? <label className="grid gap-1 text-[11px] text-muted-foreground">Run on<select aria-label="Run on" className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground" value={computerId} disabled={Boolean(editor.originalID) || committing} onChange={event => setComputerId(event.target.value)}><option value="">This computer</option>{computers.map(computer => <option key={computer.id} value={computer.id} disabled={!computer.connected}>{computer.name}{!computer.connected ? " (unavailable)" : ""}</option>)}</select></label> : undefined} focusRequest={editorFocusRequest} created={Boolean(editor.originalID && isMachineCreated?.(machine))} running={Boolean(editor.originalID && machine.kind === "vm" && isMachineRunning?.(machine))} editor={editor} baselineMachine={editorBaseline ?? undefined} conflict={editorConflict} machines={getComputerId ? machines.filter(machine => (getComputerId(machine) ?? "") === computerId) : machines} onCancel={() => setEditor(null)} onSave={save} onDraftChange={(draft) => setEditor({ ...editor, draft })} onReview={reviewConflict} onDiscard={() => setEditor(null)} />
                  ) : (
                    <SandboxListRow
                      name={machine.name}
                      kind={machine.kind}
                      onOpen={onOpenMachine && !presentation?.suppressInteractions ? () => onOpenMachine(machine) : undefined}
                      remote={Boolean(getComputerId?.(machine)) || machine.kind === "ssh"}
                      kindBadge={presentation?.kindBadge}
                      badge={presentation?.badge}
                      iconState={presentation?.iconState}
                      icon={presentation?.icon}
                      tone={presentation?.tone}
                      detail={presentation?.detail ?? machineSummary(machine)}
                      detailClassName={presentation?.detailClassName}
                      leading={<span
                        role="button"
                        tabIndex={rowInteractionsDisabled ? -1 : 0}
                        draggable={!editor && !rowInteractionsDisabled}
                        aria-label={`Reorder ${machine.name}`}
                        aria-disabled={rowInteractionsDisabled || undefined}
                        className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing aria-disabled:cursor-default aria-disabled:opacity-40"
                        onKeyDown={(event) => { if (!rowInteractionsDisabled) handleReorderKey(event, machine, index) }}
                        onDragStart={(event) => {
                          if (rowInteractionsDisabled) { event.preventDefault(); return }
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
                      actions={presentation?.actions || presentation?.menuActions ? <>{presentation?.actions}{presentation?.menuActions && <ActionsMenu label={`More actions for ${machine.name}`} disabled={rowInteractionsDisabled} popovers={{
                        ...presentation.popovers,
                        delete: close => <ConfirmBody
                          tone="destructive"
                          title={`Delete ${deletionName}?`}
                          description={deleteSandboxDescription(machine.kind)}
                          confirmLabel="Delete"
                          onClose={close}
                          onConfirm={() => deleteWithNotice(machine).then(() => undefined)}
                        />,
                      }} items={[
                        ...presentation.menuActions,
                        { label: "Edit", separatorBefore: presentation.menuActions.length > 0, icon: Pencil, accessibleLabel: `Edit ${machine.name}`, disabled: interactionDisabled, onSelect: () => startEdit(machine) },
                        { label: "Duplicate", icon: CopyPlus, accessibleLabel: `Duplicate ${machine.name}`, disabled: interactionDisabled, onSelect: () => startDuplicate(machine) },
                        ...(machine.kind === "vm" && !machine.desktop && isMachineCreated?.(machine) ? [{ label: "Add Linux desktop", icon: Monitor, disabled: interactionDisabled, onSelect: () => {
                          beginOperation()
                          captureBaseline()
                          void save({ ...machine, desktop: { startWithSandbox: true } }, machine.id, getComputerId?.(machine) ?? "")
                        } }] : []),
                        { icon: Trash2, label: "Delete", accessibleLabel: `Delete ${deletionName}`, destructive: true, disabled: interactionDisabled || runningVM, tooltip: deleteTooltip, popover: "delete" },
                      ]} />}</> : undefined}
                      actionsClassName={presentation?.actionsClassName}
                      hoverActions={presentation?.suppressInteractions || presentation?.menuActions ? undefined : <>
                        <SandboxAction label={`Edit ${machine.name}`} disabled={interactionDisabled} onClick={() => startEdit(machine)}><Pencil /></SandboxAction>
                        <SandboxAction tooltip={machine.kind === "vm" ? "Create a new VM with these settings" : "Create a new SSH configuration with these settings."} label={`Duplicate ${machine.name}`} disabled={interactionDisabled} onClick={() => startDuplicate(machine)}>
                          <CopyPlus />
                        </SandboxAction>
                        <ConfirmPopover align="end" tone="destructive" title={`Delete ${deletionName}?`} description={deleteSandboxDescription(machine.kind)} confirmLabel="Delete" tooltip={deleteTooltip ?? `Delete ${deletionName}`} onConfirm={() => remove(machine)}>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Delete ${deletionName}`} disabled={interactionDisabled || runningVM}>
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

// Reorder helpers build the same local-only configuration list the hook's saves derive.
function configurationRequestMachines(machines: SetupMachineConfiguration[], getComputerId?: (machine: SetupMachineConfiguration) => string | undefined) {
  return configurationRequest(getComputerId ? machines.filter(machine => !getComputerId(machine)) : machines).machines
}
