import { useRef, useState } from "react"

import { showActionFailure, showOperationNotice } from "@/lib/operation-toast"

import type { SetupMachineConfiguration } from "@/contracts/silo"
import {
  configurationRequest,
  duplicateMachine,
  newSSHMachine,
  newVirtualMachine,
} from "@/features/onboarding/model/machine-configuration"
import { isStaleConfigurationError } from "@/features/application/model/machine-change"
import type { MachineEditorDraft } from "@/features/onboarding/model/onboarding-draft"
import { fitMachineToCapacity, type HostCapacity } from "@/features/sandboxes/model/machine-limits"

export const defaultSaveBlockedReason = "Saving is paused while another sandbox change is in progress or needs review."

export interface MachineEditingOptions {
  machines: readonly SetupMachineConfiguration[]
  getComputerId?: (machine: SetupMachineConfiguration) => string | undefined
  onCommitMachine?: (machine: SetupMachineConfiguration, original: SetupMachineConfiguration | undefined, computerId: string, baseline?: SetupMachineConfiguration[]) => Promise<void>
  onDeleteMachine?: (machine: SetupMachineConfiguration, baseline?: SetupMachineConfiguration[]) => Promise<void>
  onMachinesChange: (machines: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[]) => Promise<void> | void
  validateOperation?: (machine: SetupMachineConfiguration, isNew: boolean, computerId?: string) => string | undefined
  isMachineRunning?: (machine: SetupMachineConfiguration) => boolean
  onEditorDraftChange?: (editor: MachineEditorDraft | null) => void
  initialEditorDraft?: MachineEditorDraft | null
  interactionDisabled?: boolean
  /** Why `interactionDisabled` blocks saving an open editor; a generic reason by default. */
  interactionDisabledReason?: string
  /** The capacity of a computer ("" is this one), when known, so new sandboxes fit it. */
  getHostCapacity?: (computerId: string) => HostCapacity | undefined
}

/**
 * Owns every piece of the sandbox editing flow — draft state, validation, stale-baseline
 * conflict detection and review, committing/deleting, and the Run-on computer selection —
 * so the sandbox list and the sandbox detail page share exactly the same behaviour. The
 * caller renders `MachineEditor` with the returned state and wires its handlers.
 */
export function useMachineEditing({
  machines,
  getComputerId,
  onCommitMachine,
  onDeleteMachine,
  onMachinesChange,
  validateOperation,
  isMachineRunning,
  onEditorDraftChange,
  initialEditorDraft = null,
  interactionDisabled = false,
  interactionDisabledReason = defaultSaveBlockedReason,
  getHostCapacity,
}: MachineEditingOptions) {
  const [computerId, setComputerId] = useState("")
  const [committing, setCommitting] = useState(false)
  const disabled = interactionDisabled || committing
  // An editor can stay open while another change starts (or fails and awaits review):
  // Save is then disabled with this reason instead of silently doing nothing.
  const saveBlockedReason = interactionDisabled ? interactionDisabledReason : undefined
  const [editorFocusRequest, setEditorFocusRequest] = useState(0)
  const [editor, setEditorState] = useState<MachineEditorDraft | null>(initialEditorDraft)
  // The saved configuration captured when the current operation began. Every local
  // save/delete/reorder carries it as the change's `expected` baseline, so a queued edit
  // applies to fresh state — or is rejected — instead of overwriting concurrent work.
  const baselineRef = useRef<SetupMachineConfiguration[] | null>(null)
  // The edited VM's baseline, plus editor conflict state, drive the in-editor notices.
  const [editorBaseline, setEditorBaseline] = useState<SetupMachineConfiguration | null>(null)
  const [editorConflict, setEditorConflict] = useState(false)
  const [editorResetToken, setEditorResetToken] = useState(0)

  function captureBaseline() {
    baselineRef.current = structuredClone(machines as SetupMachineConfiguration[])
  }

  function setEditor(next: MachineEditorDraft | null) {
    setEditorState(next)
    onEditorDraftChange?.(next)
    if (!next) { setEditorConflict(false); setEditorBaseline(null) }
  }

  function beginOperation() {
    setEditor(null)
  }

  function startEdit(machine: SetupMachineConfiguration) {
    if (disabled) return
    beginOperation()
    captureBaseline()
    setEditorBaseline(structuredClone(machine))
    setComputerId(getComputerId?.(machine) ?? "")
    setEditor({
      draft: structuredClone(machine),
      originalID: machine.id,
      insertAt: machines.findIndex(({ id }) => id === machine.id),
    })
  }

  function startAdd(kind: SetupMachineConfiguration["kind"]) {
    if (disabled) return
    beginOperation()
    captureBaseline()
    setComputerId("")
    setEditor({
      // New sandboxes start on this computer, so fit the defaults to it.
      draft: kind === "vm" ? fitMachineToCapacity(newVirtualMachine(machines), getHostCapacity?.("")) : newSSHMachine(machines),
      insertAt: machines.length,
    })
  }

  function startDuplicate(machine: SetupMachineConfiguration) {
    if (disabled) return
    beginOperation()
    captureBaseline()
    const sourceIndex = machines.findIndex(({ id }) => id === machine.id)
    setComputerId(getComputerId?.(machine) ?? "")
    setEditor({ draft: duplicateMachine(machine, machines), insertAt: sourceIndex + 1, displayAfterID: machine.id })
  }

  // Restrict a captured baseline to the machines this list actually commits (local vs a
  // single remote computer), matching the list the save is derived against.
  function scopedBaseline(): SetupMachineConfiguration[] | undefined {
    const baseline = baselineRef.current
    if (!baseline) return undefined
    return getComputerId ? baseline.filter(machine => (getComputerId(machine) ?? "") === computerId) : baseline
  }

  function dispatchChange(next: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[]) {
    // Only pass a baseline when one was captured, keeping the no-baseline call shape
    // (onboarding drafts) exactly one argument.
    const outcome = baseline ? onMachinesChange(next, baseline) : onMachinesChange(next)
    if (outcome && typeof (outcome as Promise<void>).then === "function") {
      void (outcome as Promise<void>).catch((cause) => {
        if (editor?.originalID && isStaleConfigurationError(cause)) setEditorConflict(true)
        else showActionFailure("Couldn't save changes", cause, undefined, { native: false })
      })
    }
  }

  async function save(machine: SetupMachineConfiguration, originalID = editor?.originalID, targetComputerId = computerId) {
    if (committing) return
    if (saveBlockedReason) { showActionFailure(`Couldn't save ${machine.name}`, saveBlockedReason, undefined, { native: false }); return }
    const blocked = validateOperation?.(machine, !originalID, targetComputerId)
    if (blocked) { showActionFailure(`Couldn't save ${machine.name}`, blocked, undefined, { native: false }); return }
    const baseline = baselineRef.current ?? undefined
    if (onCommitMachine) {
      setCommitting(true)
      try {
        // The expected state is what the editor opened with, so a concurrent change is
        // rejected as stale instead of silently overwritten.
        const original = baseline?.find(item => item.id === originalID) ?? machines.find(item => item.id === originalID)
        await onCommitMachine(machine, original, targetComputerId, baseline)
        setEditor(null)
      } catch (cause) {
        // A stale-baseline rejection keeps the editor open with the user's edits so they
        // can review the latest values or discard; other failures surface as before.
        if (originalID && isStaleConfigurationError(cause)) setEditorConflict(true)
        else showActionFailure(`Couldn't save ${machine.name}`, cause, undefined, { native: false })
      }
      finally { setCommitting(false) }
      return
    }
    const base = baseline ?? [...machines]
    const updated = [...base]
    if (originalID) {
      const index = updated.findIndex(({ id }) => id === originalID)
      if (index < 0) return
      updated[index] = machine
    } else {
      updated.splice(editor?.insertAt ?? updated.length, 0, machine)
    }
    dispatchChange(configurationRequest(getComputerId ? updated.filter(machine => !getComputerId(machine)) : updated).machines, baseline ? scopedBaseline() : undefined)
    setEditor(null)
  }

  function reviewConflict() {
    if (!editor?.originalID) return
    const latest = machines.find(({ id }) => id === editor.originalID)
    if (!latest) { setEditor(null); return }
    captureBaseline()
    setEditorBaseline(structuredClone(latest))
    setEditorState({ ...editor, draft: structuredClone(latest) })
    setEditorConflict(false)
    setEditorResetToken(token => token + 1)
  }

  async function remove(machine: SetupMachineConfiguration) {
    if (disabled || (machine.kind === "vm" && isMachineRunning?.(machine))) return
    beginOperation()
    captureBaseline()
    const baseline = baselineRef.current ?? undefined
    if (onDeleteMachine) {
      setCommitting(true)
      try { await onDeleteMachine(baseline?.find(item => item.id === machine.id) ?? machine, baseline) }
      catch (cause) { showActionFailure(`Couldn't delete ${machine.name}`, cause, undefined, { native: false }) }
      finally { setCommitting(false) }
      return
    }
    const base = baseline ?? machines
    dispatchChange(configurationRequest(base.filter(({ id }) => id !== machine.id)).machines, baseline ? scopedBaseline() : undefined)
  }

  // Delete a machine without the list's confirmation — the detail page confirms
  // in its own dialog, so it captures a fresh baseline and awaits the deletion here, letting
  // failures propagate to the dialog instead of the inline notice.
  async function deleteMachineNow(machine: SetupMachineConfiguration) {
    captureBaseline()
    const baseline = baselineRef.current ?? undefined
    if (onDeleteMachine) { await onDeleteMachine(machine, baseline); return }
    const base = baseline ?? machines
    const next = configurationRequest(base.filter(({ id }) => id !== machine.id)).machines
    const outcome = baseline
      ? onMachinesChange(next, scopedBaseline())
      : onMachinesChange(next)
    if (outcome) await outcome
  }

  /** Confirmed deletion (from the shared delete popover): deletes, then reports the outcome in a notification. */
  async function deleteWithNotice(machine: SetupMachineConfiguration): Promise<boolean> {
    // The popover may have been opened while the sandbox was stopped; never delete a running VM.
    if (machine.kind === "vm" && isMachineRunning?.(machine)) {
      showActionFailure(`Couldn't delete ${machine.name}`, "Stop the sandbox before deleting it.", undefined, { native: false })
      return false
    }
    try {
      await deleteMachineNow(machine)
      showOperationNotice(`sandbox-deleted:${machine.id}`, `Deleted ${machine.name}`)
      return true
    } catch (cause) {
      showActionFailure(`Couldn't delete ${machine.name}`, cause, undefined, { native: false })
      return false
    }
  }

  return {
    computerId, setComputerId,
    committing,
    interactionDisabled: disabled,
    saveBlockedReason,
    editor, setEditor,
    editorBaseline, editorConflict, editorResetToken,
    editorFocusRequest, setEditorFocusRequest,
    baselineRef,
    captureBaseline, beginOperation, scopedBaseline, dispatchChange,
    startEdit, startAdd, startDuplicate, save, remove, reviewConflict, deleteMachineNow, deleteWithNotice,
  }
}
