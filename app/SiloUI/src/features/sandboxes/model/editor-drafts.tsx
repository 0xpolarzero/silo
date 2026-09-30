import { useState, type ReactNode } from "react"

import { MachineEditorDraftsContext, type StoredMachineEditor } from "./editor-drafts-context"

/** Keeps unsaved sandbox editors for everything below it (see editor-drafts-context.ts). */
export function MachineEditorDraftsProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => new Map<string, StoredMachineEditor>())
  return <MachineEditorDraftsContext value={drafts}>{children}</MachineEditorDraftsContext>
}
