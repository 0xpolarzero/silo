import { CircleAlert } from "lucide-react"

import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import type { SetupMachineConfiguration } from "@/contracts/silo"

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

/**
 * Asked before a setup submission that would delete sandboxes already on this computer
 * which the user did not delete explicitly (the draft no longer lists them, for example
 * because it was saved before they loaded). Keeping them is the default.
 */
export function DeletionConfirmation({ machines, onKeep, onDelete }: {
  machines: readonly SetupMachineConfiguration[]
  onKeep: () => void
  onDelete: () => void
}) {
  const names = joinNames(machines.map(({ name }) => name))
  const one = machines.length === 1
  return (
    <ListCard role="alert" aria-label="Confirm sandbox deletion" className="mb-4">
      <ListRow
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-y-2 sm:flex"
        icon={<ListRowIcon className="bg-destructive/10 text-destructive" aria-hidden="true"><CircleAlert className="size-3.5" /></ListRowIcon>}
        title={<h3>{one ? `Delete ${names}?` : `Delete ${machines.length} sandboxes?`}</h3>}
        detail={`${names} already ${one ? "exists" : "exist"} on this computer but ${one ? "is" : "are"} no longer listed in setup. Continuing as listed deletes ${one ? "it and its" : "them and their"} files. Keep ${one ? "it" : "them"} to continue without deleting anything.`}
        detailClassName="whitespace-normal break-words"
        actions={<div className="col-start-2 flex shrink-0 gap-2">
          <Button type="button" variant="outline" size="xs" autoFocus onClick={onKeep}>{one ? "Keep sandbox" : "Keep sandboxes"}</Button>
          <Button type="button" variant="destructive" size="xs" onClick={onDelete}>{one ? `Delete ${names}` : `Delete ${machines.length} sandboxes`}</Button>
        </div>}
      />
    </ListCard>
  )
}
