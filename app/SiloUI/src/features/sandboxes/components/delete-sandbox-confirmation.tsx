import { useEffect, useEffectEvent, useState } from "react"

import { Button } from "@/components/ui/button"
import { deleteSandboxDescription, deleteSandboxTitle, formatSandboxSize } from "@/features/sandboxes/model/delete-sandbox-copy"

/** What the Delete sandbox dialog states and offers, shared by the list row and the sandbox page. */
export interface DeleteSandboxDetails {
  /** Checkpoints deleted with the sandbox, when known. */
  checkpoints?: number
  /** Reads the sandbox's size on this computer, in bytes. Shown when it resolves. */
  readSize?: () => Promise<number | null>
  /** Exports the sandbox and resolves true only once the export was verified. */
  exportFirst?: () => Promise<boolean>
}

/**
 * The one Delete sandbox dialog (decision 6), identical from the list row and the sandbox
 * page: "Delete {name} permanently?", what is lost with its size, and Delete permanently
 * (destructive) or Cancel. With `exportFirst`, "Export, then delete" deletes only after a
 * verified export.
 */
export function DeleteSandboxBody({ kind, displayName, details = {}, onDelete, onClose }: {
  kind: string
  /** "dev", or "dev on Office" for a remote sandbox. */
  displayName: string
  details?: DeleteSandboxDetails
  onDelete: () => void | Promise<unknown>
  onClose: () => void
}) {
  const [size, setSize] = useState<string>()
  const { exportFirst, checkpoints } = details
  // Read the size once when the dialog opens; the size is informative and deletion never waits for it.
  const readSize = useEffectEvent(() => details.readSize?.() ?? Promise.resolve(null))
  useEffect(() => {
    let current = true
    readSize()
      .then((bytes) => { if (current && bytes !== null) setSize(formatSandboxSize(bytes)) })
      .catch(() => undefined)
    return () => { current = false }
  }, [])

  function run(action: () => void | Promise<unknown>) {
    onClose()
    void Promise.resolve().then(action)
  }

  return <div className="grid gap-2">
    <p className="font-medium">{deleteSandboxTitle(displayName)}</p>
    <div className="text-muted-foreground">{deleteSandboxDescription(kind, checkpoints, size)}</div>
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      {exportFirst && <Button type="button" variant="outline" size="sm" onClick={() => run(async () => { if (await exportFirst()) await onDelete() })}>Export, then delete</Button>}
      <Button type="button" variant="destructive" size="sm" autoFocus data-popover-initial-focus="" onClick={() => run(onDelete)}>Delete permanently</Button>
    </div>
  </div>
}
