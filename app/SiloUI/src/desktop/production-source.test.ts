import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupState } from "@/features/application/model/backup-source"
import { createProductionSource, parseApplicationSource, parseBackupState, type ProductionBridge } from "./production-source"
import { siloProgressEventSchema } from "@/contracts/silo"

const source = applicationSourceForScenario("running")
const backup: BackupState = {
  snapshotId: "one",
  availability: "available",
  requiredSpaceGB: 2,
  availableSpaceGB: 40,
  archives: [{ name: "dev.silo-backup", archivePath: "/tmp/dev.silo-backup", completedLabel: "Today", size: "1 GB", destination: "/tmp", sandboxes: ["dev"] }],
  operation: null,
}

function native(overrides: Partial<ProductionBridge> = {}) {
  let event: (() => void) | null = null
  const invoke = vi.fn(async (command: string, _arguments_?: Record<string, unknown>): Promise<unknown> => {
    if (command === "read_application_state") return structuredClone(source)
    if (command === "read_backup_state") return structuredClone(backup)
    if (command === "workspace_action" || command === "retry_workspace_start") return structuredClone(source)
    return undefined
  })
  const listen = vi.fn(async (_name: string, handler: () => void) => { event = handler; return () => { event = null } })
  return { bridge: { invoke, listen, ...overrides } as ProductionBridge, invoke, emit: () => event?.() }
}

describe("production application bridge", () => {
  it("publishes saved sandbox configuration before requesting live state", async () => {
    const machines = source.workspaces.map(({ machine }) => structuredClone(machine))
    const invoke = vi.fn().mockResolvedValue({ schemaVersion: 1, machines })
    const mock = native({ invoke })
    const store = createProductionSource(mock.bridge)
    const changed = vi.fn()
    store.subscribe(changed)

    await store.loadConfiguration()

    expect(invoke).toHaveBeenCalledExactlyOnceWith("read_machine_configuration")
    expect(store.getSnapshot()).toMatchObject({ savedMachines: machines, source: null, loading: true, error: null })
    expect(changed).toHaveBeenCalledOnce()
    store.dispose()
  })

  it("accepts an empty saved configuration for a fresh install", async () => {
    const mock = native({ invoke: vi.fn().mockResolvedValue({ schemaVersion: 1, machines: [] }) })
    const store = createProductionSource(mock.bridge)

    await store.loadConfiguration()

    expect(store.getSnapshot().savedMachines).toEqual([])
    expect(store.getSnapshot().source).toBeNull()
    store.dispose()
  })

  it.each([
    { schemaVersion: 2, machines: [] },
    { schemaVersion: 1, machines: [{ name: "invalid" }] },
    { schemaVersion: 1, machines: "unreadable" },
    null,
  ])("rejects malformed saved configuration without publishing sandbox rows: %j", async (configuration) => {
    const mock = native({ invoke: vi.fn().mockResolvedValue(configuration) })
    const store = createProductionSource(mock.bridge)

    await expect(store.loadConfiguration()).rejects.toThrow()

    expect(store.getSnapshot().savedMachines).toBeUndefined()
    expect(store.getSnapshot().source).toBeNull()
    store.dispose()
  })

  it("invokes explicit host push and shows a native command failure without success", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation((command, args) => command === "push_repository" ? Promise.reject(new Error("Repository authorization was removed")) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.pushRepository("dev", "/workspace/repo")
    await vi.waitFor(() => expect(store.getSnapshot().source?.repositoryPushOperations).toContainEqual({ workspace: "dev", repositoryPath: "/workspace/repo", commitCount: 0, status: "failed", message: "Repository push failed: Repository authorization was removed" }))
    expect(mock.invoke).toHaveBeenCalledWith("push_repository", { workspace: "dev", repositoryPath: "/workspace/repo" })
    store.dispose()
  })

  it("reports a failed account connection once without inventing sandbox failures", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation((command, args) => command === "connect_github" ? Promise.reject(new Error("GitHub is not configured in this build")) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const before = store.getSnapshot().source!.github
    store.applicationActions.connectGitHub!()
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.repositoryCatalogStatus).toEqual({ status: "unavailable", message: "GitHub operation failed: GitHub is not configured in this build", canRetry: false }))
    expect(store.getSnapshot().source?.github.workspaceOperations).toEqual(before.workspaceOperations)
    expect(store.getSnapshot().source?.github.account).toEqual(before.account)
    store.dispose()
  })

  it("ignores an older settings response after a newer save completes", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    const pending: Array<(value: unknown) => void> = []
    mock.invoke.mockImplementation((command, args) => command === "save_github_configuration" ? new Promise((resolve) => { pending.push(resolve) }) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const configuration = { accessEnabled: true, hostIdentity: null, workspaces: [] }
    store.applicationActions.saveGitHubConfiguration!(configuration)
    store.applicationActions.saveGitHubConfiguration!({ ...configuration, accessEnabled: false })
    pending[1]({ ...source.github, policyRevision: 2, accessEnabled: false })
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.policyRevision).toBe(2))
    pending[0]({ ...source.github, policyRevision: 1, accessEnabled: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getSnapshot().source?.github.accessEnabled).toBe(false)
    expect(store.getSnapshot().source?.github.policyRevision).toBe(2)
    store.dispose()
  })

  it("keeps all-repository intent and waits for native acknowledgment before showing changed access", async () => {
    let resolveMutation!: (value: unknown) => void
    const request = { accessEnabled: false, hostIdentity: null, workspaces: [{ workspace: "dev", repositoryMode: "all" as const, allRepositoriesAllowChanges: false, repositories: [], identity: { name: "", email: "", apply: false } }] }
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation((command, args) => command === "save_github_configuration" ? new Promise((resolve) => { resolveMutation = resolve }) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const before = store.getSnapshot().source?.github
    store.applicationActions.saveGitHubConfiguration!(request)
    expect(mock.invoke).toHaveBeenCalledWith("save_github_configuration", { configuration: request })
    expect(store.getSnapshot().source?.github).toBe(before)
    resolveMutation({ ...before, ...request, workspaceOperations: [{ workspace: "dev", status: "failed", message: "Runtime did not acknowledge access", canRetry: true }] })
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.workspaceOperations?.[0].status).toBe("failed"))
    expect(store.getSnapshot().source?.github.workspaces?.[0].repositoryMode).toBe("all")
    store.dispose()
  })

  it("accepts activity serialized by the native journal", () => {
    const events = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../test/contracts/setup-activity.json"), "utf8")) as unknown[]
    expect(events.map((event) => siloProgressEventSchema.parse(event))).toEqual(events)
  })
  it("accepts the exact backup state serialized by the Rust bridge", () => {
    const state = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../test/contracts/backup-state.json"), "utf8"))
    expect(parseBackupState(state)).toEqual(state)
  })

  it("accepts running and failed-result variants serialized by Rust", () => {
    const operations = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../test/contracts/backup-operations.json"), "utf8")) as unknown[]
    for (const operation of operations) expect(parseBackupState({ ...backup, operation }).operation).toEqual(operation)
  })

  it("rejects malformed authoritative state instead of substituting preview data", () => {
    expect(() => parseApplicationSource({ workspaces: [] })).toThrow()
    expect(() => parseBackupState({ availability: "available", archives: [] })).toThrow()
  })

  it("does not hide a failed live-update subscription behind an initial snapshot", async () => {
    const unsubscribe = vi.fn()
    const listen = vi.fn().mockResolvedValueOnce(unsubscribe).mockRejectedValueOnce(new Error("event channel closed"))
    const mock = native({ listen })
    const store = createProductionSource(mock.bridge)
    await expect(store.initialize()).rejects.toThrow("Silo could not subscribe to application updates: event channel closed")
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(store.getSnapshot().source).toBeNull()
    store.dispose()
  })

  it("loads both native snapshots and refreshes after a workspace action", async () => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(store.getSnapshot().source?.workspaces[0].machine.name).toBe("dev")
    expect(store.getSnapshot().backup.archives[0].archivePath).toBe("/tmp/dev.silo-backup")
    store.applicationActions.stopWorkspace("dev")
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("workspace_action", { action: "stop", name: "dev" }))
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([command]) => command === "read_application_state")).toHaveLength(2))
    store.dispose()
  })

  it("keeps detected identity across VM results that omit it, then accepts a fresh missing identity", async () => {
    const hostIdentity = { name: "Host Author", email: "host@example.test" }
    let currentIdentity: typeof hostIdentity | undefined = hostIdentity
    const machineResult = structuredClone(source)
    delete machineResult.github.hostIdentity
    const mock = native({ invoke: vi.fn(async (command) => {
      if (command === "read_application_state") return { ...structuredClone(source), github: { ...source.github, hostIdentity: currentIdentity } }
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "read_setup_activity") return []
      if (command === "save_machine_configuration") return machineResult
    }) as ProductionBridge["invoke"] })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    await store.configureMachines({ schemaVersion: 1, machines: source.workspaces.map(({ machine }) => machine) })
    expect(store.getSnapshot().source?.github.hostIdentity).toEqual(hostIdentity)
    currentIdentity = undefined
    await store.refresh()
    expect(store.getSnapshot().source?.github.hostIdentity).toBeUndefined()
    store.dispose()
  })

  it("reports unreadable activity without replacing it with success or raw diagnostics", async () => {
    const mock = native({ invoke: vi.fn(async (command) => {
      if (command === "read_setup_activity") throw new Error("private path and token")
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
    }) as ProductionBridge["invoke"] })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(store.getSnapshot().setupActivityError).toBe("Saved setup activity could not be loaded. Retry by reopening Silo.")
    expect(store.getSnapshot().setupEvents).toEqual([])
    expect(store.getSnapshot().source).not.toBeNull()
    store.dispose()
  })

  it("coalesces duplicate in-flight workspace actions", async () => {
    let finish: (() => void) | undefined
    const mock = native()
    mock.invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "workspace_action") {
        await new Promise<void>((resolve) => { finish = resolve })
        return structuredClone(source)
      }
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.stopWorkspace("dev")
    store.applicationActions.stopWorkspace("dev")
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([command]) => command === "workspace_action")).toHaveLength(1))
    finish?.()
    store.dispose()
  })

  it("publishes exact bridge failures and never records a successful state change", async () => {
    const mock = native()
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "workspace_action") throw new Error("runtime refused stop")
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.stopWorkspace("dev")
    await vi.waitFor(() => expect(store.getSnapshot().source?.vmOperationsUnavailable).toBe("Stop failed for dev: runtime refused stop Refresh to confirm its current state."))
    expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.state).toBe("running")
    expect(store.getSnapshot().source?.workspaces.every(({ freshness }) => freshness === "stale")).toBe(true)
    store.dispose()
  })

  it("clears stale application state when an authoritative refresh fails", async () => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(store.getSnapshot().source?.workspaces[0].machine.name).toBe("dev")
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "read_application_state") throw new Error("runtime state unavailable")
      if (command === "read_backup_state") return structuredClone(backup)
      return undefined
    })
    await store.refresh()
    expect(store.getSnapshot().source).toBeNull()
    expect(store.getSnapshot().error).toBe("Silo could not read application state: runtime state unavailable")
    store.dispose()
  })

  it("keeps a visible failed restore result when native operation state is malformed", async () => {
    let broken = false
    const mock = native()
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "start_restore") { broken = true; return undefined }
      if (command === "read_backup_state") return broken ? { ...backup, operation: { kind: "running", running_names: [] } } : structuredClone(backup)
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.backupActions.startRestore(backup.archives[0], "restored", "dev")
    await vi.waitFor(() => expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "result", operation: "restore", outcome: "failed", targetName: "restored" }))
    expect(store.getSnapshot().backup.operation).toMatchObject({ message: expect.stringContaining("invalid backup state") })
    store.dispose()
  })

  it("coalesces duplicate in-flight backup starts", async () => {
    let finish: (() => void) | undefined
    const mock = native()
    mock.invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "start_backup") await new Promise<void>((resolve) => { finish = resolve })
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.backupActions.startBackup("/Volumes/Backups", ["dev"])
    store.backupActions.startBackup("/Volumes/Backups", ["dev"])
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([command]) => command === "start_backup")).toHaveLength(1))
    finish?.()
    store.dispose()
  })

  it("uses native archive paths and destination pickers", async () => {
    const mock = native()
    mock.invoke.mockImplementation(async (command: string, _arguments_?: Record<string, unknown>) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "choose_backup_destination") return "/Volumes/Backups"
      if (command === "choose_backup_archive") return "/Volumes/Backups/dev.silo-backup"
      if (command === "inspect_backup_archive") return { archive: backup.archives[0], valid: true }
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(await store.backupActions.chooseDestination()).toBe("/Volumes/Backups")
    await store.backupActions.chooseArchive()
    expect(mock.invoke).toHaveBeenCalledWith("inspect_backup_archive", { archivePath: "/Volumes/Backups/dev.silo-backup" })
    store.backupActions.startRestore(backup.archives[0], "dev-restored")
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("start_restore", { archivePath: "/tmp/dev.silo-backup", newName: "dev-restored" }))
    store.dispose()
  })
})
