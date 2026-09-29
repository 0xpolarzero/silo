import { useId } from "react"

import { InlineConfirmation } from "@/components/inline-confirmation"
import { Button } from "@/components/ui/button"
import type { ApplicationWorkspace } from "@/features/application/model/application-source"

/** Quit stops Silo-owned local VMs only; remote sandboxes keep running (decision 7). */
export function sandboxesStoppedByQuit(workspaces: ApplicationWorkspace[]): string[] {
  return workspaces
    .filter((workspace) => !workspace.computer && workspace.machine.kind === "vm" && (workspace.state === "running" || workspace.state === "starting"))
    .map(({ machine }) => machine.name)
}

export function quitConfirmationDetail(names: string[]): string {
  return `This stops ${names.length} running ${names.length === 1 ? "sandbox" : "sandboxes"}: ${names.join(", ")}.`
}

export function QuitConfirmation({ names, onCancel, onQuit }: { names: string[]; onCancel: () => void; onQuit: () => void }) {
  const titleId = useId()
  const detailId = useId()
  return (
    <InlineConfirmation active onDismiss={onCancel}>
      <div role="alertdialog" aria-labelledby={titleId} aria-describedby={detailId} className="grid w-full gap-2 text-xs">
        <p id={titleId} className="font-medium">Quit Silo?</p>
        <p id={detailId} className="text-muted-foreground">{quitConfirmationDetail(names)}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="destructive" size="sm" autoFocus onClick={onQuit}>Quit and stop</Button>
        </div>
      </div>
    </InlineConfirmation>
  )
}
