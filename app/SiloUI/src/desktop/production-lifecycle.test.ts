import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupState } from "@/features/application/model/backup-source"
import { createProductionSource, type ProductionBridge } from "./production-source"

const source = applicationSourceForScenario("running")
const backup: BackupState = { snapshotId: "one", availability: "available", requiredSpaceGB: 2, availableSpaceGB: 40, archives: [], operation: null }

function bridge(options: { failListen?: (name: string) => boolean; invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> | undefined } = {}) {
  const handlers = new Map<string, (event?: { payload: unknown }) => void>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    const custom = options.invoke?.(command, args)
    if (custom) return custom
    if (command === "read_application_state") return structuredClone(source)
    if (command === "read_backup_state") return structuredClone(backup)
    if (command === "remote_host_list") return []
    if (command === "read_operation_queue") return { running: [], waiting: [] }
    return undefined
  })
  const listen = vi.fn(async (name: string, handler: (event?: { payload: unknown }) => void) => {
    if (options.failListen?.(name)) throw new Error("event channel closed")
    handlers.set(name, handler)
    return () => { handlers.delete(name) }
  })
  const count = (command: string) => invoke.mock.calls.filter(([name]) => name === command).length
  return { bridge: { invoke, listen } as unknown as ProductionBridge, invoke, listen, handlers, count }
}

describe("production source start-up", () => {
  it("subscribes, polls and refreshes on focus when Retry initializes again after a failed subscription", async () => {
    vi.useFakeTimers()
    let failures = 1
    const mock = bridge({ failListen: (name) => name === "silo://operation-queue-changed" && failures-- > 0 })
    const store = createProductionSource(mock.bridge)
    try {
      await expect(store.initialize()).rejects.toThrow("Silo could not subscribe to application updates: event channel closed")
      expect(store.getSnapshot().error).toMatch(/could not subscribe/)
      expect(mock.handlers.size).toBe(0)

      await store.initialize()
      expect(store.getSnapshot().source).not.toBeNull()
      expect(store.getSnapshot().error).toBeNull()
      expect(mock.handlers.has("silo://application-state-changed")).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      const reads = mock.count("read_application_state")
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mock.count("read_application_state")).toBe(reads + 1)
      window.dispatchEvent(new Event("focus"))
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.count("read_application_state")).toBe(reads + 2)
    } finally {
      store.dispose()
      vi.useRealTimers()
    }
  })

  it("only refreshes when initialized again while already live", async () => {
    vi.useFakeTimers()
    const mock = bridge()
    const store = createProductionSource(mock.bridge)
    try {
      await store.initialize()
      await vi.advanceTimersByTimeAsync(0)
      const listens = mock.listen.mock.calls.length
      const reads = mock.count("read_application_state")
      await store.initialize()
      expect(mock.listen.mock.calls.length).toBe(listens)
      expect(mock.count("read_application_state")).toBe(reads + 1)
      // One interval: a single poll per tick.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mock.count("read_application_state")).toBe(reads + 2)
    } finally {
      store.dispose()
      vi.useRealTimers()
    }
  })
})
