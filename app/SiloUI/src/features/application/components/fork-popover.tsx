import { useState } from "react"

import { FormBody } from "@/components/confirm-popover"
import { Input } from "@/components/ui/input"

/** The fork form, shown in an `ActionsMenu` popover (`popover: "fork"`): asks for the new sandbox name. Owns the name so it resets each time it opens. */
export function ForkBody({ sandboxName, title, description, disabled = false, onFork, onClose }: {
  sandboxName: string
  /** Defaults to "Fork <sandboxName>"; a checkpoint fork names the source checkpoint. */
  title?: string
  description?: string
  disabled?: boolean
  onFork: (name: string) => void | Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState("")
  return <FormBody
    title={title ?? `Fork ${sandboxName}`}
    description={description ?? "Creates a stopped fork from the current state."}
    confirmLabel="Fork"
    canSubmit={!disabled && name.trim().length > 0}
    onSubmit={() => onFork(name.trim())}
    onClose={onClose}
    fields={<Input technical aria-label="New sandbox name" className="h-7 text-xs" maxLength={32} value={name} placeholder="New sandbox name" onChange={event => setName(event.target.value)} />}
  />
}
