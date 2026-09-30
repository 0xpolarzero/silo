import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RuntimeMigrationBoundary } from "./runtime-migration-boundary"

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => false }))
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }))

// Matches MigrationState's serde camelCase JSON, including its version and
// omitted Option fields, rather than passing a typed frontend state directly.
const failedJson = JSON.parse(`{"version":1,"status":"failed","stage":"Converting dev disks","logs":["Conversion failed"],"migratedCount":1,"failedCount":1,"totalCount":2,"canContinue":true,"logPath":"/tmp/silo-migration.log","error":"dev could not be converted"}`)
const completeJson = JSON.parse(`{"version":1,"status":"complete","stage":"Ready","logs":[],"migratedCount":2,"failedCount":0,"totalCount":2,"canContinue":false}`)

beforeEach(() => { native.invoke.mockReset(); native.listen.mockClear() })

function renderNativeGate() {
  return render(<RuntimeMigrationBoundary><p>Normal application</p></RuntimeMigrationBoundary>)
}

describe("native migration boundary", () => {
  it("parses backend JSON and retries migration through the native command", async () => {
    native.invoke.mockImplementation(async command => {
      if (command === "read_runtime_migration_state") return failedJson
      if (command === "retry_runtime_migration") return completeJson
      throw new Error(`Unexpected migration command: ${command}`)
    })
    renderNativeGate()
    expect(await screen.findByText("Some sandboxes could not be migrated")).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("dev could not be converted")
    fireEvent.click(screen.getByRole("button", { name: "Show logs" }))
    expect(screen.getByText("Full log: /tmp/silo-migration.log")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry migration" }))
    expect(await screen.findByText("Normal application")).toBeVisible()
    expect(native.invoke.mock.calls).toEqual([["read_runtime_migration_state"], ["retry_runtime_migration"]])
    expect(native.listen).toHaveBeenCalledWith("silo://application-state-changed", expect.any(Function))
  })

  it("continues through the native command only after the user acknowledges failure", async () => {
    native.invoke.mockImplementation(async command => {
      if (command === "read_runtime_migration_state") return failedJson
      if (command === "continue_after_migration_failure") return completeJson
      throw new Error(`Unexpected migration command: ${command}`)
    })
    renderNativeGate()
    const continueButton = await screen.findByRole("button", { name: "Continue with available sandboxes" })
    expect(continueButton).toBeDisabled()
    expect(native.invoke).not.toHaveBeenCalledWith("continue_after_migration_failure")
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(continueButton)
    expect(await screen.findByText("Normal application")).toBeVisible()
    expect(native.invoke.mock.calls).toEqual([["read_runtime_migration_state"], ["continue_after_migration_failure"]])
  })

  it.each([
    ["unknown status", { ...completeJson, status: "ready" }],
    ["negative count", { ...completeJson, migratedCount: -1 }],
    ["fractional count", { ...completeJson, failedCount: 0.5 }],
    ["missing stage", { ...completeJson, stage: undefined }],
    ["non-string log", { ...completeJson, logs: [23] }],
    ["non-boolean continue", { ...completeJson, canContinue: "true" }],
  ])("keeps the gate closed when backend JSON has %s", async (_case, response) => {
    native.invoke.mockResolvedValue(response)
    renderNativeGate()
    expect(await screen.findByRole("alert")).toBeVisible()
    expect(screen.getByText("Migration status is unavailable")).toBeVisible()
    expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("read_runtime_migration_state")
  })
})
