import { useState, type ReactNode } from "react"

import { FormPopover } from "@/components/confirm-popover"
import { Input } from "@/components/ui/input"

/** Ask for the new sandbox name in a popover anchored to `anchor` (the ⋯ menu); progress continues in a notification. */
export function ForkPopover({ open, onOpenChange, anchor, sandboxName, title, description, disabled = false, onFork }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The ⋯ menu (or button) the popover attaches to. */
  anchor: ReactNode
  sandboxName: string
  /** Defaults to "Fork <sandboxName>"; a checkpoint fork names the source checkpoint. */
  title?: string
  description?: string
  disabled?: boolean
  onFork: (name: string) => void | Promise<void>
}) {
  const [name, setName] = useState("")
  return <FormPopover
    open={open}
    onOpenChange={next => { if (!next) setName(""); onOpenChange(next) }}
    anchor={anchor}
    align="end"
    title={title ?? `Fork ${sandboxName}`}
    description={description ?? "Creates a stopped fork from the current state."}
    confirmLabel="Fork"
    canSubmit={!disabled && name.trim().length > 0}
    onSubmit={() => onFork(name.trim())}
    fields={<Input aria-label="New sandbox name" className="h-7 text-xs" maxLength={32} value={name} placeholder="New sandbox name" onChange={event => setName(event.target.value)} />}
  />
}
