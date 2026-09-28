import type { SetupMachineConfiguration } from "@/contracts/silo"

/**
 * One targeted change to the local VM inventory, matching the backend
 * `change_machine_configuration` command. `expected` (and `expectedOrder`) carry the
 * configuration the edit started from so the backend can apply the change to fresh
 * state — or reject it if the VM changed while the request waited its turn — instead
 * of overwriting concurrent work with a stale whole-list snapshot.
 */
export type MachineConfigurationChange =
  | { kind: "upsert"; machine: SetupMachineConfiguration; expected: SetupMachineConfiguration | null }
  | { kind: "delete"; vmId: string; expected: SetupMachineConfiguration }
  | { kind: "reorder"; order: string[]; expectedOrder: string[] }
  | { kind: "batch"; changes: MachineConfigurationChange[] }

/** Field-order-independent structural comparison of two machine configurations. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`
}

function sameMachine(a: SetupMachineConfiguration, b: SetupMachineConfiguration | undefined): boolean {
  return b !== undefined && stableStringify(a) === stableStringify(b)
}

/**
 * Field-order-independent equality of two machine configurations. Used by the editor
 * to notice, while a form is open, that the committed configuration diverged from the
 * baseline the user started editing from.
 */
export function sameMachineConfiguration(
  a: SetupMachineConfiguration | undefined,
  b: SetupMachineConfiguration | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  return stableStringify(a) === stableStringify(b)
}

/** The keys whose values differ between two machine configurations. */
export function divergentMachineFields(
  a: SetupMachineConfiguration,
  b: SetupMachineConfiguration,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((key) =>
    stableStringify((a as Record<string, unknown>)[key]) !== stableStringify((b as Record<string, unknown>)[key]),
  )
}

/**
 * Recognize the backend's optimistic-concurrency rejection, raised when a targeted
 * change's `expected` no longer matches the VM's saved configuration because it changed
 * while the user's edit waited. The backend phrases both the per-VM and reorder variants
 * with this stem, so match on it rather than on the whole sentence.
 */
export function isStaleConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return message.includes("changed while your edit was waiting")
}

/**
 * Reduce an edited local VM list to the targeted changes needed to turn the committed
 * configuration `previous` into `next`, each carrying the state it started from so the
 * backend applies it to fresh state (or rejects it) instead of overwriting concurrent
 * work with a stale whole-list snapshot.
 *
 * Returns an ordered list: deletions, then creations (`expected: null` = must not yet
 * exist), then in-place edits, or a single reorder when only the order changed. An empty
 * list means the submission is a no-op and the backend need not be called. The caller
 * sends one change on its own or several as a `batch`. The UI applies one
 * create/edit/delete/reorder at a time; onboarding submits several creations at once.
 */
export function deriveMachineChanges(
  previous: SetupMachineConfiguration[],
  next: SetupMachineConfiguration[],
): MachineConfigurationChange[] {
  const prevById = new Map(previous.map((machine) => [machine.id, machine]))
  const nextById = new Map(next.map((machine) => [machine.id, machine]))
  const added = next.filter((machine) => !prevById.has(machine.id))
  const removed = previous.filter((machine) => !nextById.has(machine.id))
  const changed = next.filter((machine) => prevById.has(machine.id) && !sameMachine(machine, prevById.get(machine.id)))

  const changes: MachineConfigurationChange[] = []
  for (const machine of removed) changes.push({ kind: "delete", vmId: machine.id, expected: machine })
  for (const machine of added) changes.push({ kind: "upsert", machine, expected: null })
  for (const machine of changed) changes.push({ kind: "upsert", machine, expected: prevById.get(machine.id) ?? null })

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    const order = next.map((machine) => machine.id)
    const expectedOrder = previous.map((machine) => machine.id)
    if (order.length === expectedOrder.length && order.some((id, index) => id !== expectedOrder[index])) {
      changes.push({ kind: "reorder", order, expectedOrder })
    }
  }
  return changes
}
