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

describe("production setup drain", () => {
  it("stops waiting for GitHub access when Quit drains setup and names the work meanwhile", async () => {
    const workspace = source.workspaces[0].machine.name
    const applying = { ...source.github, policyRevision: 3, workspaceOperations: [{ workspace, status: "applying", message: "Applying access" }] }
    let resolveIdentity!: () => void
    const identity = new Promise<void>((resolve) => { resolveIdentity = resolve })
    const mock = bridge({ invoke: (command) => {
      if (command === "save_github_configuration" || command === "read_github_state") return Promise.resolve(structuredClone(applying))
      if (command === "configure_workspace_identities") return identity.then(() => null)
      if (command === "verify_workspace_identities") return Promise.resolve(false)
      if (command === "read_setup_activity") return Promise.resolve([])
      return undefined
    } })
    const store = createProductionSource(mock.bridge)
    try {
      await store.initialize()
      const request = {
        machineConfiguration: { schemaVersion: 1 as const, machines: source.workspaces.filter(({ computer }) => !computer).map(({ machine }) => machine) },
        applications: source.preferences,
        github: { connectionState: "connected" as const, workspaces: source.workspaces.filter(({ computer }) => !computer).map(({ machine }) => ({ workspace: machine.name, repositories: [], identity: { name: "Test", email: "test@example.invalid", apply: true } })) },
      }
      const finished = store.finishSetup(request, vi.fn(async () => {}))
      void finished.catch(() => {})
      await vi.waitFor(() => expect(mock.count("configure_workspace_identities")).toBe(1))
      let drained = false
      const drain = store.drainSetup().then(() => { drained = true })
      expect(store.getSnapshot().setupDrain).toBe("Finishing setup (applying Git identities, verifying GitHub access, saving setup)…")
      resolveIdentity()
      await vi.waitFor(() => expect(mock.count("save_github_configuration")).toBe(1))
      // The verification loop ends at once instead of polling for up to five minutes.
      await vi.waitFor(() => expect(drained).toBe(true), { timeout: 2000 })
      await drain
      await expect(finished).rejects.toThrow(/Silo is quitting/)
      expect(mock.count("read_github_state")).toBe(0)
      expect(store.getSnapshot().setupDrain).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it("wakes a GitHub access poll that is already waiting", async () => {
    vi.useFakeTimers()
    const workspace = source.workspaces[0].machine.name
    const applying = { ...source.github, policyRevision: 3, workspaceOperations: [{ workspace, status: "applying", message: "Applying access" }] }
    const mock = bridge({ invoke: (command) => {
      if (command === "save_github_configuration" || command === "read_github_state") return Promise.resolve(structuredClone(applying))
      if (command === "configure_workspace_identities") return Promise.resolve(null)
      if (command === "verify_workspace_identities") return Promise.resolve(false)
      if (command === "read_setup_activity") return Promise.resolve([])
      return undefined
    } })
    const store = createProductionSource(mock.bridge)
    try {
      await store.initialize()
      const machines = source.workspaces.filter(({ computer }) => !computer).map(({ machine }) => machine)
      const step = store.submitSetupStep("github", {
        machineConfiguration: { schemaVersion: 1, machines },
        applications: source.preferences,
        github: { connectionState: "connected", workspaces: machines.map((machine) => ({ workspace: machine.name, repositories: [], identity: { name: "Test", email: "test@example.invalid", apply: true } })) },
      })
      const outcome = expect(step).rejects.toThrow(/Silo is quitting/)
      await vi.advanceTimersByTimeAsync(1_200)
      const polls = mock.count("read_github_state")
      expect(polls).toBeGreaterThan(0)
      let drained = false
      void store.drainSetup().then(() => { drained = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(drained).toBe(true)
      await outcome
      expect(mock.count("read_github_state")).toBe(polls)
    } finally {
      store.dispose()
      vi.useRealTimers()
    }
  })
})

describe("saved sandbox list for the loading skeleton", () => {
  const machine = source.workspaces[0].machine
  it.each([
    ["an unreadable list", () => Promise.reject(new Error("configuration locked")), []],
    ["an over-long list", () => Promise.resolve({ schemaVersion: 1, machines: Array.from({ length: 65 }, () => machine) }), Array.from({ length: 65 }, () => machine)],
    ["a newer schema with an unknown entry", () => Promise.resolve({ schemaVersion: 2, machines: [machine, { id: "x", kind: "future" }] }), [machine]],
  ] as const)("never fails startup on %s", async (_case, read, expected) => {
    const mock = bridge({ invoke: (command) => command === "read_machine_configuration" ? read() : undefined })
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const store = createProductionSource(mock.bridge)
    try {
      await expect(store.loadConfiguration()).resolves.toBeUndefined()
      expect(store.getSnapshot().savedMachines).toEqual(expected)
      if (expected.length === 0) expect(logged).toHaveBeenCalledWith("Silo saved sandboxes:", "configuration locked")
    } finally { store.dispose() }
  })
})

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
