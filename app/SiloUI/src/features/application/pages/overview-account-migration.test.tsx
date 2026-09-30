import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { fixtureAccountMigrationPlan, fixtureBackupDirectory } from "@/fixtures/account-migration"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { AccountMigrationOutcome, ApplicationActions, ApplicationSource } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function legacySource(): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.runtimeRepair = null
  source.sandboxConfigurationOperation = null
  source.activities = []
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  Object.assign(dev, { state: "stopped", stateDetail: "Stopped", attention: undefined, freshness: "fresh", accountMigration: { status: "required" } })
  return source
}

function actionsFor(source: ApplicationSource, migrate: () => Promise<AccountMigrationOutcome>) {
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  return {
    planAccountMigration: vi.fn(async () => fixtureAccountMigrationPlan(dev, undefined)),
    migrateAccount: vi.fn(migrate),
    startWorkspace: vi.fn(),
  } as unknown as ApplicationActions & { migrateAccount: ReturnType<typeof vi.fn>; startWorkspace: ReturnType<typeof vi.fn> }
}

async function migrateFromTheRowMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Migrate dev to the silo account" }))
  await user.click(await screen.findByRole("button", { name: "Migrate" }))
}

it("offers migration only for a sandbox on the old account layout, with Start disabled until then", async () => {
  const source = legacySource()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actionsFor(source, async () => ({ succeeded: true }))} onMachinesChange={vi.fn()} />)

  const row = document.querySelector<HTMLElement>(`[data-machine-id="${source.workspaces.find(({ machine }) => machine.name === "dev")!.machine.id}"]`)!
  expect(row).toHaveTextContent("Old account layout: migrate it to use it")
  expect(within(row).getByRole("button", { name: "Start dev" })).toBeDisabled()

  await user.click(screen.getByRole("button", { name: "More actions for playgrounds" }))
  expect(screen.queryByRole("menuitem", { name: /to the silo account/ })).toBeNull()
})

it("migrates from the row menu, then offers Start with the backup location", async () => {
  const source = legacySource()
  const actions = actionsFor(source, async () => ({ succeeded: true, backupDirectory: fixtureBackupDirectory("dev") }))
  const user = userEvent.setup()
  const view = render(<><OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} /><Toaster /></>)

  await migrateFromTheRowMenu(user)
  expect(actions.migrateAccount).toHaveBeenCalledWith("dev")
  const toast = (await screen.findByText("dev now uses the silo account")).closest<HTMLElement>("[data-sonner-toast]")!
  expect(toast).toHaveTextContent(`It is stopped. Start it when you’re ready, then check your agents and files. The backup is kept in ${fixtureBackupDirectory("dev")}.`)

  // The migrated sandbox arrives with the next state; Start then acts on it.
  const migrated = structuredClone(source)
  delete migrated.workspaces.find(({ machine }) => machine.name === "dev")!.accountMigration
  view.rerender(<><OverviewPage source={migrated} actions={actions} onMachinesChange={vi.fn()} /><Toaster /></>)
  await user.click(within(toast).getByRole("button", { name: "Start" }))
  expect(actions.startWorkspace).toHaveBeenCalledWith("dev")
})

it("reports a failure with its Details and backup, and Retry runs the same migration again", async () => {
  const source = legacySource()
  const actions = actionsFor(source, async () => ({ succeeded: false, backupDirectory: fixtureBackupDirectory("dev"), error: "The account migration inside the sandbox stopped: Account verification failed.", diagnostic: "Exit code 1\nRuntimeError: Account verification failed." }))
  const user = userEvent.setup()
  render(<><OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} /><Toaster /></>)

  await migrateFromTheRowMenu(user)
  const toast = (await screen.findByText("Could not migrate dev")).closest<HTMLElement>("[data-sonner-toast]")!
  expect(toast).toHaveTextContent("The account migration inside the sandbox stopped: Account verification failed.")
  expect(toast).toHaveTextContent(`The backup is kept in ${fixtureBackupDirectory("dev")}. Retry continues with it.`)
  await user.click(within(toast).getByRole("button", { name: "Show details" }))
  expect(within(toast).getByLabelText("Error details")).toHaveTextContent("RuntimeError: Account verification failed.")
  await user.click(within(toast).getByRole("button", { name: "Retry" }))
  await vi.waitFor(() => expect(actions.migrateAccount).toHaveBeenCalledTimes(2))
})

it("says a cancelled migration left the sandbox unchanged", async () => {
  const source = legacySource()
  const actions = actionsFor(source, () => Promise.reject({ code: "cancelled", message: "Migrating dev to the silo account was cancelled." }))
  const user = userEvent.setup()
  render(<><OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} /><Toaster /></>)

  await migrateFromTheRowMenu(user)
  expect(await screen.findByText("Migration cancelled")).toBeVisible()
  expect(screen.getByText("dev was not changed. It is stopped.")).toBeVisible()
})

it("retries a failed migration from the sandbox page", async () => {
  const source = legacySource()
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  dev.accountMigration = { status: "failed", error: "Silo could not start the sandbox: The runtime is busy.", backupDirectory: fixtureBackupDirectory("dev") }
  const actions = actionsFor(source, async () => ({ succeeded: true }))
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: "Open dev" }))
  const alert = await screen.findByRole("alert", { name: "Account migration failed" })
  expect(alert).toHaveTextContent("Silo could not start the sandbox: The runtime is busy.")
  expect(screen.getByRole("button", { name: "Start dev" })).toBeDisabled()
  await act(async () => { await user.click(within(alert).getByRole("button", { name: "Retry migrating dev" })) })
  expect(actions.migrateAccount).toHaveBeenCalledWith("dev")
})
