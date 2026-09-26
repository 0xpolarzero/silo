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
