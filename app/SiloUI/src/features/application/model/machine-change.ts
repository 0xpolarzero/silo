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
 * Classify a single edit to the local VM list into a targeted change against the
 * committed configuration `previous`. Returns null when the change is a no-op or
 * cannot be expressed as one targeted operation, so the caller can fall back to
 * replacing the whole list. The UI applies one create/edit/delete/reorder at a time,
 * so this single-change classification is exact for normal use.
 */
export function deriveMachineChange(
  previous: SetupMachineConfiguration[],
  next: SetupMachineConfiguration[],
): MachineConfigurationChange | null {
  const prevById = new Map(previous.map((machine) => [machine.id, machine]))
  const nextById = new Map(next.map((machine) => [machine.id, machine]))
  const added = next.filter((machine) => !prevById.has(machine.id))
  const removed = previous.filter((machine) => !nextById.has(machine.id))

  if (removed.length === 1 && added.length === 0) {
    // A deletion is only targeted when every surviving machine is unchanged.
    if (next.every((machine) => sameMachine(machine, prevById.get(machine.id)))) {
      return { kind: "delete", vmId: removed[0].id, expected: removed[0] }
    }
    return null
  }
  if (added.length === 1 && removed.length === 0) {
    if (previous.every((machine) => sameMachine(machine, nextById.get(machine.id)))) {
      return { kind: "upsert", machine: added[0], expected: null }
    }
    return null
  }
  if (added.length === 0 && removed.length === 0) {
    const changed = next.filter((machine) => !sameMachine(machine, prevById.get(machine.id)))
    if (changed.length === 1) {
      return { kind: "upsert", machine: changed[0], expected: prevById.get(changed[0].id) ?? null }
    }
    if (changed.length === 0) {
      const order = next.map((machine) => machine.id)
      const expectedOrder = previous.map((machine) => machine.id)
      if (order.length === expectedOrder.length && order.some((id, index) => id !== expectedOrder[index])) {
        return { kind: "reorder", order, expectedOrder }
      }
    }
    return null
  }
  return null
}
