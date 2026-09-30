import { CopyPlus, Monitor, Pencil, Trash2 } from "lucide-react"

import type { MenuAction } from "@/components/actions-menu"
import type { SetupMachineConfiguration, SetupVirtualMachineConfiguration } from "@/contracts/silo"

export interface SandboxEditMenuOptions {
  machine: SetupMachineConfiguration
  /** Names the sandbox with its computer when remote ("dev on Office"). */
  displayName: string
  disabled: boolean
  /** The sandbox exists in the runtime, so a Linux desktop can be added to it. */
  created: boolean
  /** A running VM must be stopped before it can be deleted. */
  running: boolean
  separatorBefore: boolean
  onEdit: () => void
  onDuplicate?: () => void
  onAddDesktop: (machine: SetupVirtualMachineConfiguration) => void
}

/**
 * The Edit, Duplicate, Add Linux desktop and Delete items of a sandbox's ⋯ menu, built once
 * for its list row and its page. Delete opens the menu's "delete" popover.
 */
export function sandboxEditMenu({ machine, displayName, disabled, created, running, separatorBefore, onEdit, onDuplicate, onAddDesktop }: SandboxEditMenuOptions): MenuAction[] {
  const runningVM = machine.kind === "vm" && running
  return [
    { label: "Edit", separatorBefore, icon: Pencil, accessibleLabel: `Edit ${machine.name}`, disabled, onSelect: onEdit },
    { label: "Duplicate", icon: CopyPlus, accessibleLabel: `Duplicate ${machine.name}`, disabled: disabled || !onDuplicate, onSelect: () => onDuplicate?.() },
    ...(machine.kind === "vm" && !machine.desktop && created ? [{ label: "Add Linux desktop", icon: Monitor, disabled, onSelect: () => onAddDesktop(machine) }] : []),
    { label: "Delete", icon: Trash2, accessibleLabel: `Delete ${displayName}`, destructive: true, disabled: disabled || runningVM, tooltip: runningVM ? "Stop the sandbox before deleting it." : undefined, popover: "delete" },
  ]
}
