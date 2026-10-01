import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { createFixtureMigrationBackend, createFixturePreUpgradeBackup, fixtureDeleteFailure, type PreUpgradeBackupFixtureOptions } from "@/fixtures/pre-upgrade-backup"
import { RuntimeMigrationBoundary } from "./runtime-migration-boundary"

function setup(options: PreUpgradeBackupFixtureOptions = {}) {
  const preUpgradeBackup = createFixturePreUpgradeBackup(options)
  const user = userEvent.setup()
  render(<RuntimeMigrationBoundary backend={createFixtureMigrationBackend(preUpgradeBackup)}><p>Normal application</p></RuntimeMigrationBoundary>)
  return { backup: preUpgradeBackup, user }
}

describe("migration complete: pre-upgrade backup", () => {
  it("tells the user the backup was kept, how big it is and the date it is deleted, before opening Silo", async () => {
    const { backup, user } = setup()
    expect(await screen.findByRole("heading", { name: "Your sandboxes were updated" })).toBeVisible()
    expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Pre-upgrade backup" })).toBeVisible()
    expect(await screen.findByText("12.40 GiB")).toBeVisible()
    // A date, not a countdown.
    expect(screen.getByText("Silo deletes it automatically on October 15, 2026.")).toBeVisible()
    expect(screen.queryByText(/\bdays?\b/i)).not.toBeInTheDocument()
    // Linux disk images: copyable, not browsable. The notice points to Settings for Show.
    expect(screen.getByText(/copy it but not browse its files/)).toBeVisible()
    expect(screen.getByText(/Settings, General, Storage/)).toBeVisible()
    expect(screen.getByRole("button", { name: "Delete now" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Open Silo" }))
    expect(await screen.findByText("Normal application")).toBeVisible()
    expect(backup.calls).toContain("acknowledge")
    expect(backup.calls).not.toContain("remove")
  })

  it("shows the notice only until it was acknowledged, without measuring on later launches", async () => {
    const { backup } = setup({ noticePending: false })
    expect(await screen.findByText("Normal application")).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Your sandboxes were updated" })).not.toBeInTheDocument()
    // Opening Silo at every launch must not walk the backup.
    expect(backup.calls).toEqual(["read"])
  })

  it("opens Silo when there is no backup to report", async () => {
    const { backup } = setup({ gone: true })
    expect(await screen.findByText("Normal application")).toBeVisible()
    expect(backup.calls).toEqual(["read"])
  })

  it("opens Silo rather than blocking it when the backup cannot be read", async () => {
    const backup = createFixturePreUpgradeBackup()
    vi.spyOn(backup, "read").mockRejectedValue("Silo application storage is unavailable.")
    render(<RuntimeMigrationBoundary backend={createFixtureMigrationBackend(backup)}><p>Normal application</p></RuntimeMigrationBoundary>)
    expect(await screen.findByText("Normal application")).toBeVisible()
  })

  it("stays neutral while the backup is being read", async () => {
    let finish!: (value: null) => void
    const backup = createFixturePreUpgradeBackup()
    const read = vi.fn(() => new Promise<null>(resolve => { finish = resolve }))
    backup.read = read
    render(<RuntimeMigrationBoundary backend={createFixtureMigrationBackend(backup)}><p>Normal application</p></RuntimeMigrationBoundary>)
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(screen.getByText("Opening Silo…")).toBeInTheDocument()
    expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Your sandboxes were updated" })).not.toBeInTheDocument()
    await act(async () => finish(null))
    expect(await screen.findByText("Normal application")).toBeVisible()
  })

  it("says Silo will not delete the backup by itself when it cannot read its date", async () => {
    setup({ deleteAt: null })
    expect(await screen.findByText("Silo will not delete it automatically.")).toBeVisible()
  })

  it("asks before deleting and deletes only after confirmation", async () => {
    const { backup, user } = setup()
    await user.click(await screen.findByRole("button", { name: "Delete now" }))
    expect(await screen.findByText("Delete the pre-upgrade backup permanently?")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(backup.calls).not.toContain("remove")
    await user.click(screen.getByRole("button", { name: "Delete now" }))
    await user.click(await screen.findByRole("button", { name: "Delete permanently" }))
    expect(await screen.findByText("The pre-upgrade backup was deleted.")).toBeVisible()
    expect(backup.calls.filter(call => call === "remove")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Delete now" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open Silo" }))
    expect(await screen.findByText("Normal application")).toBeVisible()
  })

  it("keeps the backup and the screen on failure so the user can retry", async () => {
    const { backup, user } = setup({ failures: 1 })
    await user.click(await screen.findByRole("button", { name: "Delete now" }))
    await user.click(await screen.findByRole("button", { name: "Delete permanently" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(fixtureDeleteFailure)
    expect(screen.getByRole("heading", { name: "Pre-upgrade backup" })).toBeVisible()
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete now" })).toBeEnabled())
    await user.click(screen.getByRole("button", { name: "Delete now" }))
    await user.click(await screen.findByRole("button", { name: "Delete permanently" }))
    expect(await screen.findByText("The pre-upgrade backup was deleted.")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(backup.calls.filter(call => call === "remove")).toHaveLength(2)
  })

  it("keeps the screen when a change is reported while it is open", async () => {
    const { backup, user } = setup()
    await screen.findByRole("heading", { name: "Your sandboxes were updated" })
    // Another deletion (the automatic one) reports a change: the notice says so, it does not vanish.
    await act(async () => { await backup.remove() })
    expect(await screen.findByText("The pre-upgrade backup was deleted.")).toBeVisible()
    expect(screen.queryByText("Normal application")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open Silo" }))
    expect(await screen.findByText("Normal application")).toBeVisible()
  })

  it("opens Silo even when recording that the notice was shown fails", async () => {
    const { backup, user } = setup()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    backup.acknowledge = async () => { throw new Error("disk full") }
    await user.click(await screen.findByRole("button", { name: "Open Silo" }))
    expect(await screen.findByText("Normal application")).toBeVisible()
    await waitFor(() => expect(errors).toHaveBeenCalledWith("Silo pre-upgrade backup:", "disk full"))
  })

  it("is not offered while the migration is unfinished or failed", async () => {
    const backup = createFixturePreUpgradeBackup()
    const migration = { ...createFixtureMigrationBackend(backup), read: async () => ({ status: "running" as const, stage: "Converting sandbox 1 of 2", logs: [], migratedCount: 0, failedCount: 0, totalCount: 2, canContinue: false }) }
    render(<RuntimeMigrationBoundary backend={migration}><p>Normal application</p></RuntimeMigrationBoundary>)
    expect(await screen.findByText("Updating your sandboxes")).toBeVisible()
    expect(backup.calls).toEqual([])
  })
})
