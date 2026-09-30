import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { fixtureAccountMigrationPlan, fixtureBackupDirectory } from "@/fixtures/account-migration"
import type { AccountMigrationPlan, ApplicationWorkspace } from "../model/application-source"
import { AccountMigrationBody, AccountMigrationNotice } from "./account-migration"

function legacyWorkspace(accountMigration: ApplicationWorkspace["accountMigration"] = { status: "required" }): ApplicationWorkspace {
  const workspace = structuredClone(applicationSourceForScenario("complete")).workspaces.find(({ machine }) => machine.name === "dev")!
  return { ...workspace, state: "stopped", accountMigration }
}

function plan(change: Partial<AccountMigrationPlan> = {}): AccountMigrationPlan {
  return { ...fixtureAccountMigrationPlan(legacyWorkspace(), undefined), ...change }
}

it("shows the dry-run plan, the backup size and location, the free space and the rewrite warning", async () => {
  const onMigrate = vi.fn()
  const onClose = vi.fn()
  const user = userEvent.setup()
  render(<AccountMigrationBody sandboxName="dev" plan={() => Promise.resolve(plan())} onMigrate={onMigrate} onClose={onClose} />)

  expect(screen.getByRole("status")).toHaveTextContent("Checking dev and the free space for its backup…")
  const steps = await screen.findByRole("list", { name: "Migration steps" })
  expect(within(steps).getAllByRole("listitem").map(item => item.textContent)).toEqual(plan().steps)
  expect(screen.getByRole("note")).toHaveTextContent("This rewrites files inside dev")
  expect(screen.getByText("Up to 6.6 GiB")).toBeVisible()
  expect(screen.getByText(fixtureBackupDirectory("dev"))).toBeVisible()
  expect(screen.getByText("31.8 GiB available, needs about 8.6 GiB")).toBeVisible()

  await user.click(screen.getByRole("button", { name: "Migrate" }))
  expect(onClose).toHaveBeenCalled()
  await vi.waitFor(() => expect(onMigrate).toHaveBeenCalledOnce())
})

it("refuses to migrate while the backup does not fit, and checks the space again on request", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce(plan({ availableBytes: 4 * 1024 ** 3, enoughSpace: false }))
    .mockResolvedValueOnce(plan())
  const onMigrate = vi.fn()
  const user = userEvent.setup()
  render(<AccountMigrationBody sandboxName="dev" computerName="Office" plan={read} onMigrate={onMigrate} onClose={vi.fn()} />)

  expect(await screen.findByRole("alert")).toHaveTextContent("Not enough free space for the backup. Free up at least 4.6 GiB on Office, then check again. Nothing was changed.")
  expect(screen.queryByRole("button", { name: "Migrate" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "Check again" }))
  expect(await screen.findByRole("button", { name: "Migrate" })).toBeEnabled()
  expect(read).toHaveBeenCalledTimes(2)
  expect(onMigrate).not.toHaveBeenCalled()
})

it("offers Retry for an earlier attempt, and reports a failed dry run", async () => {
  const user = userEvent.setup()
  const view = render(<AccountMigrationBody sandboxName="dev" plan={() => Promise.resolve(plan({ resume: true, backupBytes: 0 }))} onMigrate={vi.fn()} onClose={vi.fn()} />)
  expect(await screen.findByText("Continue migrating dev")).toBeVisible()
  expect(screen.getByText("The earlier backup is kept and used.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible()
  view.unmount()

  const read = vi.fn().mockRejectedValueOnce({ code: "internal", message: "dev already uses the silo account." }).mockResolvedValueOnce(plan())
  render(<AccountMigrationBody sandboxName="dev" plan={read} onMigrate={vi.fn()} onClose={vi.fn()} />)
  expect(await screen.findByRole("alert")).toHaveTextContent("dev already uses the silo account.")
  await user.click(screen.getByRole("button", { name: "Check again" }))
  expect(await screen.findByRole("button", { name: "Migrate" })).toBeVisible()
})

it("replaces the dead-end start error with Migrate on the sandbox page", async () => {
  const onMigrate = vi.fn()
  const user = userEvent.setup()
  render(<AccountMigrationNotice workspace={legacyWorkspace()} disabled={false} plan={() => Promise.resolve(plan())} onMigrate={onMigrate} />)

  expect(screen.getByRole("note", { name: "Old account layout" })).toHaveTextContent("dev uses the old account layout, so Silo can’t start or open it.")
  await user.click(screen.getByRole("button", { name: "Migrate dev to the silo account" }))
  await user.click(await screen.findByRole("button", { name: "Migrate" }))
  await vi.waitFor(() => expect(onMigrate).toHaveBeenCalledOnce())
})

it("shows the exact failure with Details, the backup location and Retry", async () => {
  const onRetry = vi.fn()
  const user = userEvent.setup()
  const diagnostic = "Exit code 1\nRuntimeError: UID/GID 1001 belongs to another account."
  const view = render(<AccountMigrationNotice workspace={legacyWorkspace({ status: "failed", error: "The account migration inside the sandbox stopped: UID/GID 1001 belongs to another account.", diagnostic, backupDirectory: fixtureBackupDirectory("dev") })} disabled={false} onRetry={onRetry} />)

  const alert = screen.getByRole("alert", { name: "Account migration failed" })
  expect(alert).toHaveTextContent("The account migration inside the sandbox stopped: UID/GID 1001 belongs to another account.")
  expect(within(alert).getByText(fixtureBackupDirectory("dev"))).toBeVisible()
  await user.click(within(alert).getByRole("button", { name: "Show details" }))
  expect(within(alert).getByLabelText("Error details")).toHaveTextContent("Exit code 1")
  await user.click(screen.getByRole("button", { name: "Retry migrating dev" }))
  expect(onRetry).toHaveBeenCalledOnce()

  view.rerender(<AccountMigrationNotice workspace={legacyWorkspace({ status: "failed", error: "Silo could not back up the disks: Not enough free disk space." })} disabled onRetry={onRetry} />)
  expect(screen.getByText("No backup was kept. Retry backs up the disks again.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Retry migrating dev" })).toBeDisabled()
})

it("shows the running step instead of any action", () => {
  render(<AccountMigrationNotice workspace={legacyWorkspace({ status: "running", stage: "Backing up the disks" })} disabled={false} onRetry={vi.fn()} />)
  expect(screen.getByRole("status", { name: "Account migration" })).toHaveTextContent("Moving dev to the silo account: Backing up the disks…")
  expect(screen.queryByRole("button")).toBeNull()
})
