import { useState, type ReactNode } from "react"

import { ComputerEditorDraftsContext, type StoredComputerEditor } from "./editor-drafts-context"

/** Keeps unsaved computer editors for everything below it (see editor-drafts-context.ts). */
export function ComputerEditorDraftsProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => new Map<string, StoredComputerEditor>())
  return <ComputerEditorDraftsContext value={drafts}>{children}</ComputerEditorDraftsContext>
}
