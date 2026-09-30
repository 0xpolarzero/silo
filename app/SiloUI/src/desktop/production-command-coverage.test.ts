import { afterEach, describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupState } from "@/features/application/model/backup-source"
import { remoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { assertNativeBridgeMocksHandled, nativeBridgeMock, type NativeCommandHandlers } from "@/test/native-bridge-mock"
import { createProductionSource, type ProductionBridge } from "./production-source"

afterEach(assertNativeBridgeMocksHandled)

const source = applicationSourceForScenario("running")
const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "1 GiB", destination: "/backups", sandboxes: ["dev"] }
const backup: BackupState = { snapshotId: "1", availability: "available", archives: [archive], operation: null }

function bridge(handlers: NativeCommandHandlers = {}) {
  const invoke = nativeBridgeMock({
    read_application_state: () => structuredClone(source),
    read_backup_state: () => structuredClone(backup),
    read_setup_activity: () => [],
    read_network_state: () => ({ workspaces: [] }),
    remote_network_state: () => ({ workspaces: [] }),
    remote_host_list: () => [],
    remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "developer@laptop" }),
    read_operation_queue: () => ({ running: [], waiting: [] }),
    ...handlers,
  })
  return { invoke, listen: vi.fn(async () => () => {}) } as unknown as ProductionBridge & { invoke: typeof invoke }
}

describe("production command behavior", () => {
  it("dismisses only the matching remote completed push and retains other results and running pushes", async () => {
    const remote = structuredClone(source)
    const completed = { workspace: "dev", repositoryPath: "/workspace/repo", commitCount: 1, status: "succeeded" as const }
    remote.repositoryPushOperations = [completed, { ...completed, repositoryPath: "/workspace/other" }, { ...completed, status: "pushing" }]
    let reads = 0
    let holdRefresh!: () => void
    const refreshed = new Promise<void>(resolve => { holdRefresh = resolve })
    const native = bridge({
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: async () => { if (reads++ > 0) await refreshed; return structuredClone(remote) },
      dismiss_repository_push: () => undefined,
    })
    const store = createProductionSource(native)
    const target = remoteWorkspaceTarget("office", remote.workspaces[0].machine.id)
    try {
      await store.initialize()
      await vi.waitFor(() => expect(store.getSnapshot().source?.repositoryPushOperations.filter(operation => operation.workspace === target)).toHaveLength(3))
      store.statusActions.dismissRepositoryPush(target, "/workspace/repo")
      await vi.waitFor(() => expect(store.getSnapshot().source?.repositoryPushOperations.filter(operation => operation.workspace === target)).toEqual([
        expect.objectContaining({ repositoryPath: "/workspace/other", status: "succeeded" }),
        expect.objectContaining({ repositoryPath: "/workspace/repo", status: "pushing" }),
      ]))
      expect(native.invoke).toHaveBeenCalledWith("dismiss_repository_push", { workspace: target, repositoryPath: "/workspace/repo" })
      // The owner's cache must stay dismissed even when local state refreshes.
      await store.refresh()
      expect(store.getSnapshot().source?.repositoryPushOperations.filter(operation => operation.workspace === target)).toHaveLength(2)
    } finally { holdRefresh(); store.dispose() }
  })

  it("stops GitHub verification at 300 seconds and leaves setup incomplete", async () => {
    vi.useFakeTimers()
    const machines = source.workspaces.filter(({ computer }) => !computer).map(({ machine }) => machine)
    const github = { ...source.github, policyRevision: 3, workspaceOperations: machines.map(({ name }) => ({ workspace: name, status: "applying", message: "Applying access" })) }
    const native = bridge({
      configure_workspace_identities: () => undefined,
      verify_workspace_identities: () => false,
      save_github_configuration: () => structuredClone(github),
      read_github_state: () => structuredClone(github),
    })
    const store = createProductionSource(native)
    try {
      await store.initialize()
      const complete = vi.fn(async () => {})
      const finished = store.finishSetup({
        machineConfiguration: { schemaVersion: 1, machines }, applications: source.preferences,
        github: { connectionState: "connected", workspaces: machines.map(machine => ({ workspace: machine.name, repositories: [], identity: { name: "Test", email: "test@example.invalid", apply: true } })) },
      }, complete)
      const failure = vi.fn()
      void finished.catch(failure)
      await vi.advanceTimersByTimeAsync(0)
      expect(native.invoke).toHaveBeenCalledWith("save_github_configuration", expect.anything())
      await vi.advanceTimersByTimeAsync(299_999)
      expect(failure).not.toHaveBeenCalled()
      expect(complete).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(failure).toHaveBeenCalledWith(new Error("GitHub access has not been verified in every sandbox. Retry to check again."))
      expect(complete).not.toHaveBeenCalled()
      const polls = native.invoke.mock.calls.filter(([command]) => command === "read_github_state").length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(native.invoke.mock.calls.filter(([command]) => command === "read_github_state")).toHaveLength(polls)
    } finally { store.dispose(); vi.useRealTimers() }
  })

  it("refreshes transfer state after cancelling and reveals the selected archive path", async () => {
    let cancelled = false
    const native = bridge({
      cancel_backup_operation: () => { cancelled = true },
      read_backup_state: () => ({ ...backup, snapshotId: cancelled ? "cancelled" : "1" }),
      reveal_backup_archive: () => undefined,
    })
    const store = createProductionSource(native)
    try {
      await store.initialize()
      store.backupActions.cancelOperation()
      await vi.waitFor(() => expect(store.getSnapshot().backup.snapshotId).toBe("cancelled"))
      expect(native.invoke).toHaveBeenCalledWith("cancel_backup_operation")
      await store.backupActions.revealArchive(archive)
      expect(native.invoke).toHaveBeenCalledWith("reveal_backup_archive", { archivePath: archive.archivePath })
    } finally { store.dispose() }
  })

  it("reports failed cancellation through the integration error command and preserves archive reveal failures", async () => {
    const native = bridge({
      cancel_backup_operation: () => { throw new Error("Bridge closed") },
      reveal_backup_archive: () => { throw new Error("Archive missing") },
      show_integration_error: () => undefined,
    })
    const store = createProductionSource(native)
    try {
      await store.initialize()
      store.backupActions.cancelOperation()
      await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("show_integration_error", {
        message: "Export or import cancellation failed: Bridge closed The operation may still be running.",
      }))
      await expect(store.backupActions.revealArchive(archive)).rejects.toThrow("Archive missing")
    } finally { store.dispose() }
  })
})
