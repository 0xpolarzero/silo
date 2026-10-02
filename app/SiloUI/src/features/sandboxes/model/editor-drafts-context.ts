import { createContext, useContext } from "react"

import type { SetupMachineConfiguration } from "@/contracts/silo"
import type { MachineEditorDraft } from "@/features/onboarding/model/onboarding-draft"

/**
 * Open sandbox editors, kept in memory while the application window is mounted, so
 * navigating away (⌘1–7, ⌘[, the breadcrumb) and back restores the unsaved edit instead of
 * discarding it. Each editor surface uses its own key (the list, or one sandbox's page).
 * Save, Cancel and Discard clear the entry. Onboarding persists its editor itself
 * (`onEditorDraftChange`); without a `MachineEditorDraftsProvider` nothing is kept.
 */
export interface StoredMachineEditor {
  editor: MachineEditorDraft
  /** The edited sandbox's saved configuration when the editor opened. */
  editorBaseline: SetupMachineConfiguration | null
  /** Every sandbox's saved configuration when the edit began (the change's `expected`). */
  baseline: SetupMachineConfiguration[] | null
  computerId: string
  /** A save that must stay locked and settle even if its editor surface unmounts. */
  pendingSave?: Promise<void>
}

export const MachineEditorDraftsContext = createContext<Map<string, StoredMachineEditor> | null>(null)

export function useMachineEditorDrafts() {
  return useContext(MachineEditorDraftsContext)
}
