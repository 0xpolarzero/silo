import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupState } from "@/features/application/model/backup-source"
import { createProductionSource, type ProductionBridge } from "./production-source"

// State-handling behaviour of the production source: request deduplication,
// refresh ordering, polling and merges of partial native responses.

const toasts = vi.hoisted(() => ({ showOperationFailure: vi.fn() }))
vi.mock("@/lib/operation-toast", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/operation-toast")>(), showOperationFailure: toasts.showOperationFailure }))

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

  it("keeps an explicit Disable access when setup saves GitHub settings (H-39)", async () => {
    const dev = source.workspaces[0]
    const disabled = { ...source, workspaces: [dev], github: { ...source.github, state: "connected" as const, account: "octo", policyRevision: 3, accessEnabled: false } }
    const saved = { ...disabled.github, policyRevision: 4, workspaceOperations: [{ workspace: dev.machine.name, status: "succeeded", message: "Applied" }] }
    const mock = bridge(command => {
      if (command === "read_application_state") return structuredClone(disabled)
      if (command === "configure_workspace_identities") return null
      if (command === "save_github_configuration") return structuredClone(saved)
    })
    const store = createProductionSource(mock.native)
    try {
      await store.initialize()
      await store.submitSetupStep("github", {
        machineConfiguration: { schemaVersion: 1, machines: [dev.machine] },
        applications: source.preferences,
        github: { connectionState: "connected", workspaces: [{ workspace: dev.machine.name, repositories: [], identity: { name: "Test", email: "test@example.invalid", apply: true } }] },
      })
      expect(mock.invoke).toHaveBeenCalledWith("save_github_configuration", { configuration: expect.objectContaining({ accessEnabled: false }) })
    } finally { store.dispose() }
  })
})

describe("GitHub state from full reads", () => {
  it("shows the unavailable state a failed GitHub read reports without a policy revision (H-20)", async () => {
    let failed = false
    const connected = { ...source, github: { ...source.github, state: "connected" as const, account: "octo", policyRevision: 4, repositoryCatalog: ["acme/silo"], repositoryCatalogStatus: { status: "available" as const } } }
    const fallback = { ...source, github: { state: "disconnected", accessEnabled: false, repositoryCatalog: [], repositoryCatalogStatus: { status: "unavailable", message: "GitHub settings could not be read.", canRetry: true }, workspaceOperations: [] } }
    const mock = bridge(command => command === "read_application_state" ? structuredClone(failed ? fallback : connected) : undefined)
    const store = createProductionSource(mock.native)
    try {
      await store.initialize()
      expect(store.getSnapshot().source?.github).toMatchObject({ state: "connected", policyRevision: 4 })
      failed = true
      await store.refresh()
      expect(store.getSnapshot().source?.github.repositoryCatalogStatus).toEqual({ status: "unavailable", message: "GitHub settings could not be read.", canRetry: true })
      failed = false
      await store.refresh()
      expect(store.getSnapshot().source?.github).toMatchObject({ state: "connected", policyRevision: 4, repositoryCatalogStatus: { status: "available" } })
    } finally { store.dispose() }
  })

  it("still ignores an older policy revision than the one shown (H-20)", async () => {
    let revision = 4
    const mock = bridge(command => command === "read_application_state" ? { ...structuredClone(source), github: { ...source.github, policyRevision: revision, accessEnabled: revision === 4 } } : undefined)
    const store = createProductionSource(mock.native)
    try {
      await store.initialize()
      revision = 3
      await store.refresh()
      expect(store.getSnapshot().source?.github).toMatchObject({ policyRevision: 4, accessEnabled: true })
    } finally { store.dispose() }
  })
})

describe("status actions", () => {
  it("reports a failed Quit request instead of dropping it (H-25)", async () => {
    toasts.showOperationFailure.mockClear()
    const mock = bridge(command => { if (command === "quit_app") throw new Error("settings could not be saved") })
    const store = createProductionSource(mock.native)
    try {
      await store.initialize()
      store.statusActions.quit()
      await vi.waitFor(() => expect(toasts.showOperationFailure).toHaveBeenCalledWith("quit", "Could not quit Silo", { description: "settings could not be saved" }))
    } finally { store.dispose() }
  })
})
