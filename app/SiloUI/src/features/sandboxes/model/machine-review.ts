import type { SetupMachineConfiguration } from "@/contracts/silo"
import { divergentMachineFields, sameMachineConfiguration } from "@/features/application/model/machine-change"

/** A field changed both here and elsewhere since the editor opened. */
export interface MachineReviewConflict {
  field: string
  label: string
  theirs: string
  mine: string
}

/** What "Review changes" did to the draft after a stale-baseline rejection. */
export interface MachineReview {
  /** Fields changed on both sides; the draft keeps the user's value. */
  conflicts: MachineReviewConflict[]
  /** Fields changed only elsewhere; the draft now has their value. */
  adopted: string[]
}

const fieldLabels = new Map([
  ["name", "Name"], ["cpus", "CPUs"], ["maxCPUs", "CPUs ceiling"],
  ["memoryGiB", "Memory"], ["maxMemoryGiB", "Memory ceiling"],
  ["workspaceStorageGiB", "Workspace disk"], ["runtimeStorageGiB", "Runtime disk"],
  ["desktop", "Linux desktop"], ["host", "SSH host"], ["user", "SSH user"], ["port", "SSH port"],
])

/** The editor's label for a configuration field. */
export function machineFieldLabel(field: string): string {
  return fieldLabels.get(field) ?? field
}

function fieldValue(field: string, value: unknown): string {
  if (field === "cpus" || field === "maxCPUs") return `${value} ${value === 1 ? "CPU" : "CPUs"}`
  if (field === "memoryGiB" || field === "maxMemoryGiB" || field === "workspaceStorageGiB" || field === "runtimeStorageGiB") return `${value} GiB`
  if (field === "desktop") {
    if (!value) return "Not installed"
    return (value as { startWithSandbox?: boolean }).startWithSandbox === false ? "Starts from its viewer" : "Starts with sandbox"
  }
  return String(value)
}

/**
 * Rebase the user's draft onto the latest saved configuration: fields the user edited keep
 * their value, fields changed only elsewhere take the latest value (so saving does not
 * silently revert someone else's change), and fields edited on both sides are listed with
 * both values for review.
 */
export function rebaseMachineDraft(opened: SetupMachineConfiguration, latest: SetupMachineConfiguration, draft: SetupMachineConfiguration): { draft: SetupMachineConfiguration; review: MachineReview } {
  if (opened.kind !== latest.kind || draft.kind !== latest.kind) return { draft: structuredClone(latest), review: { conflicts: [], adopted: divergentMachineFields(opened, latest).map(machineFieldLabel) } }
  const fields = new Set([...Object.keys(opened), ...Object.keys(latest), ...Object.keys(draft)])
  const edited = new Set(divergentMachineFields(opened, draft))
  const changedElsewhere = new Set(divergentMachineFields(opened, latest))
  const disagree = new Set(divergentMachineFields(latest, draft))
  const mineValues = new Map<string, unknown>(Object.entries(draft))
  const theirValues = new Map<string, unknown>(Object.entries(latest))
  const merged = new Map<string, unknown>()
  const conflicts: MachineReviewConflict[] = []
  const adopted: string[] = []
  for (const field of fields) {
    const value = edited.has(field) ? mineValues.get(field) : theirValues.get(field)
    if (value !== undefined) merged.set(field, structuredClone(value))
    if (edited.has(field) && changedElsewhere.has(field) && disagree.has(field)) {
      conflicts.push({ field, label: machineFieldLabel(field), theirs: fieldValue(field, theirValues.get(field)), mine: fieldValue(field, mineValues.get(field)) })
    } else if (changedElsewhere.has(field) && !edited.has(field)) adopted.push(machineFieldLabel(field))
  }
  const rebased = Object.fromEntries(merged) as SetupMachineConfiguration
  return { draft: sameMachineConfiguration(rebased, draft) ? draft : rebased, review: { conflicts, adopted } }
}
