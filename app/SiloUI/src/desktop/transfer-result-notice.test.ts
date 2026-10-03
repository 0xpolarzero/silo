import { beforeEach, describe, expect, it, vi } from "vitest"

import { desktopTransferResultNoticeBackend, unseenTransferResult } from "./transfer-result-notice"

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => false }))
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }))

beforeEach(() => { native.invoke.mockReset(); native.listen.mockClear() })

// Matches backup_controller::BackupState's serde camelCase JSON.
const archive = { name: "dev.silo-backup", archivePath: "/exports/dev.silo-backup", completedLabel: "In progress", size: "Unknown", destination: "/exports", computers: ["dev"] }
const result = { kind: "result", operation: "backup", archive, runningNames: [], outcome: "failed", title: "Export interrupted before the upgrade", message: "Silo closed before this export finished.", detail: "No export file was saved. Export the computer again." }
const state = { snapshotId: "3", operationId: "op-1", availability: "available", archives: [], operation: result, resultUnseen: true }

describe("the unseen export or import result", () => {
  it("is the result the runtime marked unseen, with the id that acknowledges it", () => {
    expect(unseenTransferResult(state)).toEqual({ id: "op-1", operation: "backup", outcome: "failed", title: "Export interrupted before the upgrade", message: "Silo closed before this export finished.", detail: "No export file was saved. Export the computer again." })
    const { detail: _detail, ...withoutDetail } = result
    expect(unseenTransferResult({ ...state, operation: withoutDetail })).toEqual({ id: "op-1", operation: "backup", outcome: "failed", title: "Export interrupted before the upgrade", message: "Silo closed before this export finished." })
  })

  it("is nothing for an ordinary result, a running operation or no operation", () => {
    const { resultUnseen: _unseen, ...ordinary } = state
    expect(unseenTransferResult(ordinary)).toBeNull()
    expect(unseenTransferResult({ ...state, resultUnseen: false })).toBeNull()
    expect(unseenTransferResult({ ...state, operation: { ...result, kind: "running", progress: 1, phases: [] } })).toBeNull()
    expect(unseenTransferResult({ ...state, operation: null })).toBeNull()
  })

  it("is nothing without the id that would acknowledge it or the words that would show it", () => {
    const { operationId: _id, ...withoutId } = state
    expect(unseenTransferResult(withoutId)).toBeNull()
    expect(unseenTransferResult({ ...state, operation: { ...result, title: "" } })).toBeNull()
  })

  it("does not refuse a state with fields it does not show, but refuses one that is not a state", () => {
    expect(unseenTransferResult({ ...state, future: { field: 1 } })?.id).toBe("op-1")
    expect(() => unseenTransferResult("not a state")).toThrow()
    expect(() => unseenTransferResult({ operation: { title: 3 } })).toThrow()
    // An outcome this Silo does not know is not shown as something else.
    expect(() => unseenTransferResult({ ...state, operation: { ...result, outcome: "unknown" } })).toThrow()
  })

  it("is read from, and acknowledged through, the native commands", async () => {
    native.invoke.mockImplementation(async command => command === "read_backup_state" ? state : true)
    await expect(desktopTransferResultNoticeBackend.read()).resolves.toMatchObject({ id: "op-1" })
    await desktopTransferResultNoticeBackend.acknowledge("op-1")
    expect(native.invoke).toHaveBeenCalledWith("acknowledge_backup_result", { expectedOperationId: "op-1" })
    await desktopTransferResultNoticeBackend.subscribe(() => {})
    expect(native.listen).toHaveBeenCalledWith("silo://application-state-changed", expect.any(Function))
  })
})
