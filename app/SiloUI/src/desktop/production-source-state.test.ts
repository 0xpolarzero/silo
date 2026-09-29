import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupState } from "@/features/application/model/backup-source"
import { createProductionSource, type ProductionBridge } from "./production-source"

// State-handling behaviour of the production source: request deduplication,
// refresh ordering, polling and merges of partial native responses.

const source = applicationSourceForScenario("running")
const backup: BackupState = {
  snapshotId: "one",
  availability: "available",
  requiredSpaceGB: 2,
  availableSpaceGB: 40,
  archives: [],
  operation: null,
}

type Handler = (command: string, args?: Record<string, unknown>) => unknown

/** A native bridge that answers the baseline reads and delegates everything else. */
function bridge(handler: Handler = () => undefined) {
  const handlers = new Map<string, (event?: { payload: unknown }) => void>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    const answer = await handler(command, args)
    if (answer !== undefined) return answer
    if (command === "read_application_state") return structuredClone(source)
    if (command === "read_backup_state") return structuredClone(backup)
    if (command === "read_setup_activity") return []
    if (command === "read_network_state") return { workspaces: [] }
    if (command === "read_operation_queue") return { running: [], waiting: [] }
    if (command === "remote_host_list") return []
    if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }
    return undefined
  })
  const listen = vi.fn(async (name: string, handler: (event?: { payload: unknown }) => void) => { handlers.set(name, handler); return () => { handlers.delete(name) } })
  return { native: { invoke, listen } as unknown as ProductionBridge, invoke, emit: (name: string, payload?: unknown) => handlers.get(name)?.({ payload }) }
}

const count = (invoke: ReturnType<typeof vi.fn>, name: string) => invoke.mock.calls.filter(([command]) => command === name).length

describe("machine configuration jobs", () => {
  it("runs an identical retry again once the earlier one has finished (H-12)", async () => {
    const mock = bridge(command => command === "retry_machine_configuration" ? structuredClone(source) : undefined)
    const store = createProductionSource(mock.native)
    try {
      await store.initialize()
      const request = { schemaVersion: 1 as const, machines: store.getSnapshot().source!.workspaces.map(({ machine }) => machine) }
      const first = store.configureMachines(request, { kind: "retry" })
      // A repeat while the first is in flight joins it.
      expect(store.configureMachines(request, { kind: "retry" })).toBe(first)
      await first
      expect(count(mock.invoke, "retry_machine_configuration")).toBe(1)
      await store.configureMachines(request, { kind: "retry" })
      expect(count(mock.invoke, "retry_machine_configuration")).toBe(2)
    } finally { store.dispose() }
  })
})
