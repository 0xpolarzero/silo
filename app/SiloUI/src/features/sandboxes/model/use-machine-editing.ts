import { useEffect, useEffectEvent, useRef, useState } from "react"

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
import { rebaseMachineDraft, type MachineReview } from "@/features/sandboxes/model/machine-review"
import { useMachineEditorDrafts } from "@/features/sandboxes/model/editor-drafts-context"

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
  /** Why a sandbox cannot be edited or deleted now (it is starting or stopping), if so. */
  getMachineBusyReason?: (machine: SetupMachineConfiguration) => string | undefined
  /**
   * Keeps an open editor under this key in the nearest `MachineEditorDraftsProvider`, so
   * leaving the surface and coming back restores the unsaved edit. Ignored when
   * `initialEditorDraft` is given.
   */
  draftKey?: string
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
  getMachineBusyReason,
  draftKey,
}: MachineEditingOptions) {
  // Restore an editor left open on this surface earlier (see editor-drafts-context.ts).
  const drafts = useMachineEditorDrafts()
  const [stored] = useState(() => !initialEditorDraft && draftKey ? drafts?.get(draftKey) : undefined)
  const [computerId, setComputerId] = useState(stored?.computerId ?? "")
  const [committing, setCommitting] = useState(Boolean(stored?.pendingSave))
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const disabled = interactionDisabled || committing
  const [editorFocusRequest, setEditorFocusRequest] = useState(0)
  const [editor, setEditorState] = useState<MachineEditorDraft | null>(initialEditorDraft ?? stored?.editor ?? null)
  const busyReason = (machine: SetupMachineConfiguration | undefined) => machine ? getMachineBusyReason?.(machine) : undefined
  // An editor can stay open while another change starts (or fails and awaits review), or
  // while its sandbox starts or stops: Save is then disabled with this reason instead of
  // silently doing nothing or being rejected.
  const saveBlockedReason = interactionDisabled
    ? interactionDisabledReason
    : editor?.originalID ? busyReason(machines.find(({ id }) => id === editor.originalID)) : undefined
  // The saved configuration captured when the current operation began. Every local
  // save/delete/reorder carries it as the change's `expected` baseline, so a queued edit
  // applies to fresh state — or is rejected — instead of overwriting concurrent work.
  const baselineRef = useRef<SetupMachineConfiguration[] | null>(stored?.baseline ?? null)
  // The edited VM's baseline, plus editor conflict state, drive the in-editor notices.
  const [editorBaseline, setEditorBaseline] = useState<SetupMachineConfiguration | null>(stored?.editorBaseline ?? null)
  useEffect(() => {
    if (!draftKey || !drafts) return
    if (editor) drafts.set(draftKey, { editor, editorBaseline, baseline: baselineRef.current, computerId, pendingSave: drafts.get(draftKey)?.pendingSave })
    else drafts.delete(draftKey)
  }, [drafts, draftKey, editor, editorBaseline, computerId])
  const [editorConflict, setEditorConflict] = useState(false)
  const [editorReview, setEditorReview] = useState<MachineReview | null>(null)
  const [editorResetToken, setEditorResetToken] = useState(0)

  const completeRestoredSave = useEffectEvent(() => { setEditor(null); setCommitting(false) })
  // A restored editor observes the same save instead of starting another one.
  useEffect(() => {
    if (!stored?.pendingSave) return
    let current = true
    void stored.pendingSave.then(() => {
      if (current) completeRestoredSave()
    }, cause => {
      if (current) {
        if (isStaleConfigurationError(cause)) setEditorConflict(true)
        setCommitting(false)
      }
    })
    return () => { current = false }
  }, [stored])

  function captureBaseline() {
    baselineRef.current = structuredClone(machines as SetupMachineConfiguration[])
  }

  // The editor as of the latest change, for rejections that settle after it closed or moved on.
  const editorRef = useRef(editor)
  function setEditor(next: MachineEditorDraft | null) {
    editorRef.current = next
    setEditorState(next)
    onEditorDraftChange?.(next)
    if (!next) { setEditorConflict(false); setEditorBaseline(null); setEditorReview(null) }
  }

  /**
   * A stale-baseline rejection is shown in the open editor for that sandbox. With no such
   * editor (Add Linux desktop from the ⋯ menu, or a local save that closed its editor before
   * the rejection arrived), report it as a failure instead of dropping it.
   */
  function reportSaveFailure(cause: unknown, machine?: Pick<SetupMachineConfiguration, "id" | "name">) {
    if (mounted.current && machine && isStaleConfigurationError(cause) && editorRef.current?.originalID === machine.id) setEditorConflict(true)
    else showActionFailure(machine ? `Could not save ${machine.name}` : "Could not save changes", cause, undefined, { native: false })
  }

  function beginOperation() {
    setEditor(null)
  }

  function startEdit(machine: SetupMachineConfiguration) {
    if (disabled) return
    const busy = busyReason(machine)
    if (busy) { showActionFailure(`Could not edit ${machine.name}`, busy, undefined, { native: false }); return }
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

  /** Applies a whole-list change; returns its settlement (failures already reported) when asynchronous. */
  function dispatchChange(next: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[], saved?: Pick<SetupMachineConfiguration, "id" | "name">): Promise<void> | undefined {
    // Only pass a baseline when one was captured, keeping the no-baseline call shape
    // (onboarding drafts) exactly one argument.
    const outcome = baseline ? onMachinesChange(next, baseline) : onMachinesChange(next)
    if (outcome && typeof (outcome as Promise<void>).then === "function") {
      return (outcome as Promise<void>).catch((cause) => reportSaveFailure(cause, saved))
    }
    return undefined
  }

  async function save(machine: SetupMachineConfiguration, originalID = editor?.originalID, targetComputerId = computerId) {
    if (committing) return
    // Also covers menu saves with no editor open (Add Linux desktop).
    const blockedReason = saveBlockedReason ?? (originalID ? busyReason(machines.find(({ id }) => id === originalID)) : undefined)
    if (blockedReason) { showActionFailure(`Could not save ${machine.name}`, blockedReason, undefined, { native: false }); return }
    const blocked = validateOperation?.(machine, !originalID, targetComputerId)
    if (blocked) { showActionFailure(`Could not save ${machine.name}`, blocked, undefined, { native: false }); return }
    const baseline = baselineRef.current ?? undefined
    if (onCommitMachine) {
      setCommitting(true)
      let pendingSave: Promise<void> | undefined
      try {
        // The expected state is what the editor opened with, so a concurrent change is
        // rejected as stale instead of silently overwritten.
        const original = baseline?.find(item => item.id === originalID) ?? machines.find(item => item.id === originalID)
        pendingSave = onCommitMachine(machine, original, targetComputerId, baseline)
        const cached = draftKey ? drafts?.get(draftKey) : undefined
        if (cached && draftKey && cached.editor === editorRef.current) drafts?.set(draftKey, { ...cached, pendingSave })
        await pendingSave
        // Cache settlement cannot depend on an effect in an editor that has left the page.
        if (draftKey && drafts?.get(draftKey)?.pendingSave === pendingSave) drafts.delete(draftKey)
        setEditor(null)
      } catch (cause) {
        // A stale-baseline rejection keeps the editor open with the user's edits so they
        // can review the latest values or discard; other failures surface as before.
        reportSaveFailure(cause, originalID ? { id: originalID, name: machine.name } : machine)
      }
      finally {
        const cached = draftKey ? drafts?.get(draftKey) : undefined
        if (cached && draftKey && cached.pendingSave === pendingSave) drafts?.set(draftKey, { ...cached, pendingSave: undefined })
        setCommitting(false)
      }
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
    dispatchChange(configurationRequest(getComputerId ? updated.filter(machine => !getComputerId(machine)) : updated).machines, baseline ? scopedBaseline() : undefined, machine)
    setEditor(null)
  }

  // "Review changes" after a stale rejection: rebase the user's edits onto the latest saved
  // configuration (instead of replacing them), re-baseline so the next Save applies to it,
  // and list what changed on both sides.
  function reviewConflict() {
    if (!editor?.originalID) return
    const latest = machines.find(({ id }) => id === editor.originalID)
    if (!latest) { setEditor(null); return }
    const { draft, review } = rebaseMachineDraft(editorBaseline ?? latest, latest, editor.draft)
    captureBaseline()
    setEditorBaseline(structuredClone(latest))
    const next = { ...editor, draft }
    editorRef.current = next
    setEditorState(next)
    onEditorDraftChange?.(next)
    setEditorConflict(false)
    setEditorReview(review)
    setEditorResetToken(token => token + 1)
  }

  async function remove(machine: SetupMachineConfiguration) {
    if (disabled || (machine.kind === "vm" && isMachineRunning?.(machine))) return
    const busy = busyReason(machine)
    if (busy) { showActionFailure(`Could not delete ${machine.name}`, busy, undefined, { native: false }); return }
    beginOperation()
    captureBaseline()
    const baseline = baselineRef.current ?? undefined
    if (onDeleteMachine) {
      setCommitting(true)
      try { await onDeleteMachine(baseline?.find(item => item.id === machine.id) ?? machine, baseline) }
      catch (cause) { showActionFailure(`Could not delete ${machine.name}`, cause, undefined, { native: false }) }
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
    if (disabled) throw new Error(interactionDisabledReason)
    const blocked = validateOperation?.(machine, false, getComputerId?.(machine) ?? "")
    if (blocked) throw new Error(blocked)
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
      showActionFailure(`Could not delete ${machine.name}`, "Stop the sandbox before deleting it.", undefined, { native: false })
      return false
    }
    const busy = busyReason(machine)
    if (busy) {
      showActionFailure(`Could not delete ${machine.name}`, busy, undefined, { native: false })
      return false
    }
    try {
      await deleteMachineNow(machine)
      showOperationNotice(`sandbox-deleted:${machine.id}`, `Deleted ${machine.name}`)
      return true
    } catch (cause) {
      showActionFailure(`Could not delete ${machine.name}`, cause, undefined, { native: false })
      return false
    }
  }

  return {
    computerId, setComputerId,
    committing,
    interactionDisabled: disabled,
    saveBlockedReason,
    editor, setEditor,
    editorBaseline, editorConflict, editorReview, editorResetToken,
    editorFocusRequest, setEditorFocusRequest,
    baselineRef,
    captureBaseline, beginOperation, scopedBaseline, dispatchChange,
    startEdit, startAdd, startDuplicate, save, remove, reviewConflict, deleteMachineNow, deleteWithNotice,
  }
}
