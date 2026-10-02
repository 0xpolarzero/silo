import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { ExportIncompleteError, type BackupOperation, type BackupState } from "@/features/application/model/backup-source"
import { createProductionSource, type ProductionBridge } from "./production-source"

// E-59: "Export, then delete" needs an export whose promise settles with that
// specific export's verified result, never with another operation's.

const source = applicationSourceForScenario("running")
const exported = { name: "dev-2026-09-29.silo-backup", archivePath: "/Volumes/Backups/dev-2026-09-29.silo-backup", completedLabel: "Intact archive", size: "1.0 GiB", destination: "/Volumes/Backups", sandboxes: ["dev"] }
const idle: BackupState = { snapshotId: "1", availability: "available", archives: [], operation: null }

const running: BackupOperation = { kind: "running", operation: "backup", archive: exported, runningNames: [], progress: 0, phases: [] }

function result(outcome: "success" | "failed" | "cancelled", message = "done"): BackupOperation {
  return { kind: "result", operation: "backup", archive: exported, runningNames: [], outcome, title: "Export", message }
}

function bridge(start: (args?: Record<string, unknown>) => Promise<unknown>) {
  let backup: BackupState = idle
  const handlers = new Map<string, () => void>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "read_application_state") return structuredClone(source)
    if (command === "read_backup_state") return structuredClone(backup)
    if (command === "start_backup") {
      // Like the Rust side, a started export is reported as running under its id.
      const id = await start(args)
      backup = { ...idle, operationId: String(id), operation: running }
      return id
    }
    return undefined
  })
  const listen = vi.fn(async (name: string, handler: () => void) => { handlers.set(name, handler); return () => handlers.delete(name) })
  return {
    bridge: { invoke, listen } as unknown as ProductionBridge,
    invoke,
    /** Replace the backend's export and import state and announce it like the Rust side does. */
    publish(next: BackupState) { backup = next; handlers.get("silo://application-state-changed")?.() },
  }
}

async function store(start: (args?: Record<string, unknown>) => Promise<unknown>) {
  const native = bridge(start)
  const production = createProductionSource(native.bridge)
  await production.initialize()
  return { ...native, production }
}

describe("export and verify", () => {
  it("resolves with the verified archive once this operation succeeds", async () => {
    const { production, publish, invoke } = await store(async () => "op-1")
    const completion = production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"])
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("start_backup", { destination: "/Volumes/Backups", sandboxes: ["dev"] }))
    publish({ ...idle, operationId: "op-1", operation: running })
    publish({ ...idle, operationId: "op-1", operation: result("success") })
    await expect(completion).resolves.toEqual({ operationId: "op-1", archive: exported })
    production.dispose()
  })

  it("never settles with another operation's result", async () => {
    let finishStart: ((id: string) => void) | undefined
    const { production, publish } = await store(() => new Promise(resolve => { finishStart = resolve }))
    const settled = vi.fn()
    const completion = production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"])
    completion.then(settled, settled)
    // An earlier export's success is still on screen while this one starts.
    publish({ ...idle, operationId: "old-op", operation: result("success") })
    await vi.waitFor(() => expect(finishStart).toBeDefined())
    finishStart?.("op-2")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).not.toHaveBeenCalled()
    publish({ ...idle, operationId: "op-2", operation: result("failed", "The destination disconnected.") })
    const error = await completion.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ExportIncompleteError)
    expect(error).toMatchObject({ reason: "failed", operationId: "op-2", message: "The destination disconnected." })
    production.dispose()
  })

  it("rejects when this export is cancelled or its result disappears", async () => {
    const cancelled = await store(async () => "op-3")
    const first = cancelled.production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"])
    await vi.waitFor(() => expect(cancelled.invoke).toHaveBeenCalledWith("start_backup", expect.anything()))
    cancelled.publish({ ...idle, operationId: "op-3", operation: result("cancelled", "The operation was cancelled.") })
    await expect(first).rejects.toMatchObject({ reason: "cancelled", operationId: "op-3" })
    cancelled.production.dispose()

    const lost = await store(async () => "op-4")
    const second = lost.production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"])
    await vi.waitFor(() => expect(lost.invoke).toHaveBeenCalledWith("start_backup", expect.anything()))
    await new Promise(resolve => setTimeout(resolve, 0))
    lost.publish({ ...idle, operationId: "op-5", operation: null })
    await expect(second).rejects.toMatchObject({ reason: "unavailable", operationId: "op-4" })
    lost.production.dispose()
  })

  it("rejects without starting while another transfer runs, and when the backend refuses", async () => {
    const busy = await store(async () => "op-6")
    busy.publish({ ...idle, operationId: "op-6", operation: { kind: "running", operation: "restore", archive: exported, runningNames: [], progress: 0, phases: [] } })
    await vi.waitFor(() => expect(busy.production.getSnapshot().backup.operation?.kind).toBe("running"))
    await expect(busy.production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"])).rejects.toMatchObject({ reason: "busy" })
    expect(busy.invoke).not.toHaveBeenCalledWith("start_backup", expect.anything())
    busy.production.dispose()

    const refused = await store(async () => { throw new Error("Choose the export destination again before starting.") })
    await expect(refused.production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"], "checkpoint-1"))
      .rejects.toMatchObject({ reason: "rejected", message: "Choose the export destination again before starting." })
    expect(refused.invoke).toHaveBeenCalledWith("start_backup", { destination: "/Volumes/Backups", sandboxes: ["dev"], checkpointId: "checkpoint-1" })
    refused.production.dispose()
  })

  it("rejects a pending wait when the source is disposed", async () => {
    const { production, invoke } = await store(async () => "op-7")
    const completion = production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"])
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("start_backup", expect.anything()))
    await new Promise(resolve => setTimeout(resolve, 0))
    production.dispose()
    await expect(completion).rejects.toMatchObject({ reason: "unavailable", operationId: "op-7" })
  })

  it("rejects when the source is disposed before the export start reply arrives", async () => {
    let finishStart: ((id: string) => void) | undefined
    const { production } = await store(() => new Promise(resolve => { finishStart = resolve }))
    const rejected = vi.fn()
    const completion = production.backupActions.exportAndVerify("/Volumes/Backups", ["dev"])
    void completion.catch(rejected)
    await vi.waitFor(() => expect(finishStart).toBeDefined())
    production.dispose()
    finishStart?.("op-late")
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ reason: "unavailable", operationId: "op-late" })))
  })
})

// E-27: closing the import review stops the export file check it started.
describe("export file check", () => {
  it("tags the check with a request id, cancels it on abort, and changes no state", async () => {
    let finish: ((value: unknown) => void) | undefined
    const { production, invoke } = await store(async () => "unused")
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(idle)
      if (command === "choose_backup_archive") return "/Volumes/Backups/dev.silo-backup"
      if (command === "inspect_backup_archive") return new Promise(resolve => { finish = resolve })
      return undefined
    })
    const reads = () => invoke.mock.calls.filter(([command]) => command === "read_backup_state").length
    const before = reads()
    const abort = new AbortController()
    const checked = production.backupActions.chooseArchive(undefined, abort.signal)
    await vi.waitFor(() => expect(finish).toBeDefined())
    const call = invoke.mock.calls.find(([command]) => command === "inspect_backup_archive")
    const requestId = (call?.[1] as { requestId?: string } | undefined)?.requestId
    expect(requestId).toEqual(expect.any(String))
    abort.abort()
    expect(invoke).toHaveBeenCalledWith("cancel_backup_inspection", { requestId })
    finish?.({ archive: exported, valid: false, reason: "The operation was cancelled." })
    await checked
    expect(reads()).toBe(before)
    production.dispose()
  })
})
