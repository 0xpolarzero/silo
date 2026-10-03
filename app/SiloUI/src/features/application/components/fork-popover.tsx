import { useId, useState } from "react"

import { FormBody } from "@/components/confirm-popover"
import { Input } from "@/components/ui/input"
import { validateSandboxName } from "@/features/onboarding/model/machine-configuration"

/** The fork form, shown in an `ActionsMenu` popover (`popover: "fork"`): asks for the new sandbox name. Owns the name so it resets each time it opens. */
export function ForkBody({ sandboxName, title, description, disabled = false, takenNames = [], onFork, onClose }: {
  sandboxName: string
  /** Defaults to "Fork <sandboxName>"; a checkpoint fork names the source checkpoint. */
  title?: string
  description?: string
  disabled?: boolean
  /** Sandbox names already used on the device that will own the fork. */
  takenNames?: readonly string[]
  onFork: (name: string) => void | Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const errorID = useId()
  const trimmed = name.trim()
  const nameError = trimmed.length === 0
    ? undefined
    : validateSandboxName(trimmed) ?? (takenNames.includes(trimmed) ? `A sandbox named ${trimmed} already exists.` : undefined)
  return <FormBody
    title={title ?? `Fork ${sandboxName}`}
    description={description ?? `Creates a new stopped sandbox with a copy of this sandbox’s files. Silo adds a “Fork point” checkpoint to ${sandboxName}’s history, and a running ${sandboxName} pauses briefly while it is saved.`}
    confirmLabel="Fork"
    canSubmit={!disabled && trimmed.length > 0 && !nameError}
    onSubmit={() => onFork(trimmed)}
    onClose={onClose}
    fields={<>
      <Input technical aria-label="New sandbox name" aria-invalid={Boolean(nameError)} aria-describedby={nameError ? errorID : undefined} className="h-7 text-xs" maxLength={32} value={name} placeholder="New sandbox name" onChange={event => setName(event.target.value)} />
      {nameError && <p id={errorID} className="text-xs text-destructive">{nameError}</p>}
    </>}
  />
}
