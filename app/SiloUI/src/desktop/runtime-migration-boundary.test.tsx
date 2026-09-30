import { act, fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { RuntimeMigrationBoundary, type RuntimeMigrationBackend, type RuntimeMigrationState } from "./runtime-migration-boundary"

const failed: RuntimeMigrationState = {
  status: "failed", stage: "Converting dev disks", logs: ["Copying dev", "Conversion failed"],
  migratedCount: 1, failedCount: 1, totalCount: 2, canContinue: true,
  logPath: "/tmp/silo-migration.log", error: "dev could not be converted",
}

it("keeps the application gated through failure and requires an explicit acknowledged continue", async () => {
  let refresh: (() => void) | undefined
  const read = vi.fn().mockResolvedValue(failed)
  const retry = vi.fn().mockResolvedValue({ ...failed, status: "running", error: undefined })
  const continueAfterFailure = vi.fn().mockResolvedValue({ ...failed, status: "complete" })
  const backend: RuntimeMigrationBackend = { read, retry, continueAfterFailure, subscribe: async handler => { refresh = handler; return () => {} } }
  render(<RuntimeMigrationBoundary backend={backend}><p>Normal application</p></RuntimeMigrationBoundary>)
  expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
  await screen.findByText("Some sandboxes could not be migrated")
  expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Continue with available sandboxes" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Show logs" }))
  expect(screen.getByText(/Conversion failed/)).toBeVisible()
  expect(screen.getByRole("link", { name: "Prepare GitHub issue" })).toHaveAttribute("href", expect.stringContaining("issues/new"))
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: "Continue with available sandboxes" }))
  await screen.findByText("Normal application")
  expect(continueAfterFailure).toHaveBeenCalledOnce()
  await act(async () => { refresh?.() })
})

it("does not show the application when migration status cannot be read", async () => {
  const backend: RuntimeMigrationBackend = {
    read: () => Promise.reject(new Error("migration gate unavailable")),
    retry: vi.fn(), continueAfterFailure: vi.fn(), subscribe: async () => () => {},
  }
  render(<RuntimeMigrationBoundary backend={backend}><p>Normal application</p></RuntimeMigrationBoundary>)
  expect(await screen.findByRole("alert")).toHaveTextContent("migration gate unavailable")
  expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
})

it("offers Retry that reads migration status again after a failed read", async () => {
  const read = vi.fn()
    .mockRejectedValueOnce(new Error("migration gate unavailable"))
    .mockResolvedValue({ ...failed, status: "not-required", error: undefined })
  const backend: RuntimeMigrationBackend = { read, retry: vi.fn(), continueAfterFailure: vi.fn(), subscribe: async () => () => {} }
  render(<RuntimeMigrationBoundary backend={backend}><p>Normal application</p></RuntimeMigrationBoundary>)
  expect(await screen.findByRole("alert")).toHaveTextContent("migration gate unavailable")
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText("Normal application")).toBeVisible()
  expect(read).toHaveBeenCalledTimes(2)
})

it("subscribes again on Retry when the first subscription failed", async () => {
  const stop = vi.fn()
  const subscribe = vi.fn()
    .mockRejectedValueOnce(new Error("event bridge unavailable"))
    .mockResolvedValue(stop)
  const read = vi.fn().mockResolvedValue({ ...failed, status: "not-required", error: undefined })
  const backend: RuntimeMigrationBackend = { read, retry: vi.fn(), continueAfterFailure: vi.fn(), subscribe }
  render(<RuntimeMigrationBoundary backend={backend}><p>Normal application</p></RuntimeMigrationBoundary>)
  expect(await screen.findByRole("alert")).toHaveTextContent("event bridge unavailable")
  expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText("Normal application")).toBeVisible()
  expect(subscribe).toHaveBeenCalledTimes(2)
})

it("does not announce a migration before the first status arrives", async () => {
  let resolve!: (state: RuntimeMigrationState) => void
  const read = vi.fn(() => new Promise<RuntimeMigrationState>(done => { resolve = done }))
  const backend: RuntimeMigrationBackend = { read, retry: vi.fn(), continueAfterFailure: vi.fn(), subscribe: async () => () => {} }
  render(<RuntimeMigrationBoundary backend={backend}><p>Normal application</p></RuntimeMigrationBoundary>)
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  expect(screen.queryByText("Updating your sandboxes")).not.toBeInTheDocument()
  expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
  await act(async () => resolve({ ...failed, status: "not-required", error: undefined }))
  expect(screen.getByText("Normal application")).toBeVisible()
})

it("shows migration progress once the first status reports it", async () => {
  const backend: RuntimeMigrationBackend = {
    read: vi.fn().mockResolvedValue({ ...failed, status: "running", error: undefined }),
    retry: vi.fn(), continueAfterFailure: vi.fn(), subscribe: async () => () => {},
  }
  render(<RuntimeMigrationBoundary backend={backend}><p>Normal application</p></RuntimeMigrationBoundary>)
  expect(await screen.findByText("Updating your sandboxes")).toBeVisible()
})
