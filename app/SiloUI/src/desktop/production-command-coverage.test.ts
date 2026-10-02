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

describe("production archive inspection", () => {
  it("does not inspect or announce a cancelled archive picker", async () => {
    const native = bridge({ choose_backup_archive: () => null })
    const store = createProductionSource(native)
    const selected = vi.fn()
    try {
      await expect(store.backupActions.chooseArchive(selected)).resolves.toBeNull()
      expect(selected).not.toHaveBeenCalled()
      expect(native.invoke.mock.calls).toEqual([["choose_backup_archive"]])
    } finally { store.dispose() }
  })

  it("ignores a picker reply after its caller aborts", async () => {
    let choose!: (path: string) => void
    const native = bridge({ choose_backup_archive: () => new Promise<string>(resolve => { choose = resolve }) })
    const store = createProductionSource(native)
    const selected = vi.fn()
    const abort = new AbortController()
    try {
      const inspection = store.backupActions.chooseArchive(selected, abort.signal)
      abort.abort()
      choose(archive.archivePath)
      await expect(inspection).resolves.toBeNull()
      expect(selected).not.toHaveBeenCalled()
      expect(native.invoke.mock.calls).toEqual([["choose_backup_archive"]])
    } finally { store.dispose() }
  })

  it.each(["malformed", "rejected"] as const)("allows a fresh inspection after a %s reply and removes the old abort listener", async failureKind => {
    const failure = { code: "archive_unreadable", message: "Reconnect the backup drive" }
    let attempts = 0
    const native = bridge({ inspect_backup_archive: () => {
      if (++attempts === 1) {
        if (failureKind === "rejected") throw failure
        return { archive, valid: "yes" }
      }
      return { archive, valid: true }
    } })
    const store = createProductionSource(native)
    const abort = new AbortController()
    const before = store.getSnapshot()
    try {
      const first = store.backupActions.inspectArchive(archive, abort.signal)
      if (failureKind === "rejected") await expect(first).rejects.toBe(failure)
      else await expect(first).rejects.toThrow()
      abort.abort()
      await expect(store.backupActions.inspectArchive(archive)).resolves.toEqual({ archive, valid: true })
      const requests = native.invoke.mock.calls.map(([command, args]) => {
        expect(command).toBe("inspect_backup_archive")
        expect(args).toEqual({ archivePath: archive.archivePath, requestId: expect.any(String) })
        return args!.requestId
      })
      expect(requests).toHaveLength(2)
      expect(new Set(requests).size).toBe(2)
      expect(store.getSnapshot()).toBe(before)
    } finally { store.dispose() }
  })

  it("cancels only the requested inspection and detaches the completed inspection's signal", async () => {
    const finishes: Array<(result: unknown) => void> = []
    const native = bridge({
      inspect_backup_archive: () => new Promise(resolve => { finishes.push(resolve) }),
      cancel_backup_inspection: () => undefined,
    })
    const store = createProductionSource(native)
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const secondArchive = { ...archive, archivePath: "/backups/api.silo-backup" }
    try {
      const first = store.backupActions.inspectArchive(archive, firstAbort.signal)
      const second = store.backupActions.inspectArchive(secondArchive, secondAbort.signal)
      const requests = native.invoke.mock.calls.map(([, args]) => args!.requestId)
      expect(new Set(requests).size).toBe(2)
      expect(native.invoke).toHaveBeenNthCalledWith(2, "inspect_backup_archive", { archivePath: secondArchive.archivePath, requestId: requests[1] })
      firstAbort.abort()
      expect(native.invoke).toHaveBeenLastCalledWith("cancel_backup_inspection", { requestId: requests[0] })
      finishes[0]({ archive, valid: false, reason: "Cancelled" })
      finishes[1]({ archive: secondArchive, valid: true })
      await expect(first).resolves.toMatchObject({ valid: false })
      await expect(second).resolves.toEqual({ archive: secondArchive, valid: true })
      secondAbort.abort()
      expect(native.invoke.mock.calls.filter(([command]) => command === "cancel_backup_inspection")).toHaveLength(1)
    } finally { store.dispose() }
  })
})

describe("production command behavior", () => {
  it.each([
    ["authorizeComputer", "remote_authorize_ssh"],
    ["setupComputerKey", "remote_setup_ssh_key"],
  ] as const)("passes the address to %s and preserves a failed repair for the caller to retry", async (action, command) => {
    const failure = { code: "ssh_authentication_failed", message: "Unlock your SSH key" }
    let attempts = 0
    const native = bridge({ [command]: () => { if (++attempts === 1) throw failure } })
    const store = createProductionSource(native)
    try {
      await expect(store.applicationActions[action]!("owner@office")).rejects.toBe(failure)
      await store.applicationActions[action]!("owner@office")
      expect(native.invoke.mock.calls).toEqual([[command, { address: "owner@office" }], [command, { address: "owner@office" }]])
      expect(store.getSnapshot().error).toBeNull()
    } finally { store.dispose() }
  })

  it.each([false, true])("connects a computer with explicit address replacement=%s and publishes its authoritative list", async replaceAddress => {
    const computer = { id: "office", name: "Office", address: "owner@office" }
    let connected = false
    const native = bridge({
      connect_remote_host: () => { connected = true; return computer },
      remote_host_list: () => connected ? [computer] : [],
      remote_host_snapshot: () => structuredClone(source),
    })
    const store = createProductionSource(native)
    try {
      await store.initialize()
      await store.applicationActions.connectComputer!(computer.address, replaceAddress ? { replaceAddress } : undefined)
      expect(native.invoke).toHaveBeenCalledWith("connect_remote_host", { address: computer.address, replace: replaceAddress })
      await vi.waitFor(() => expect(store.getSnapshot().source?.remoteComputers).toContainEqual(expect.objectContaining({ id: "office", connected: true })))
      expect(store.getSnapshot().source?.workspaces.some(workspace => workspace.computer?.id === "office")).toBe(true)
    } finally { store.dispose() }
  })

  it.each(["save_secret", "remove_secret", "retry_secret"])("rejects a malformed %s reply without replacing cached secrets", async command => {
    const request = { operation: "edit" as const, id: "package-token", name: "PACKAGE_TOKEN", workspaces: ["dev"], allowedDomains: ["registry.npmjs.org"] }
    const native = bridge({ [command]: () => ({ secrets: "not a secret list" }) })
    const store = createProductionSource(native)
    try {
      await store.initialize()
      const saved = store.getSnapshot().source!.secrets
      const action = command === "save_secret" ? store.applicationActions.saveSecret(request)
        : command === "remove_secret" ? store.applicationActions.removeSecret(request.id) : store.applicationActions.retrySecret!(request.id)
      await expect(action).rejects.toThrow()
      expect(native.invoke).toHaveBeenCalledWith(command, command === "save_secret" ? { request } : { id: request.id })
      expect(store.getSnapshot().source!.secrets).toEqual(saved)
    } finally { store.dispose() }
  })

  it("preserves a computer and its rows when native connection removal is rejected", async () => {
    const failure = { code: "settings_write_failed", message: "Connection not saved" }
    const native = bridge({
      remote_host_list: () => [{ id: "office", name: "Office", address: "owner@office" }],
      remote_host_snapshot: () => structuredClone(source),
      remove_remote_host: () => { throw failure },
    })
    const store = createProductionSource(native)
    try {
      await store.initialize()
      await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces.some(workspace => workspace.computer?.id === "office")).toBe(true))
      await expect(store.applicationActions.removeComputer!("office")).rejects.toBe(failure)
      expect(native.invoke).toHaveBeenCalledWith("remove_remote_host", { hostId: "office" })
      expect(store.getSnapshot().source?.remoteComputers?.map(computer => computer.id)).toEqual(["office"])
      expect(store.getSnapshot().source?.workspaces.some(workspace => workspace.computer?.id === "office")).toBe(true)
    } finally { store.dispose() }
  })

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
