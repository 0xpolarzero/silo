import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupController } from "../model/backup-source"
import type { ApplicationActions, ApplicationSource, ApplicationComputer } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const backup = { state: { snapshotId: "1", availability: "available", archives: [], operation: null }, actions: {} } as unknown as BackupController
const actions = { forkCheckpoint: vi.fn(), readWorkspaceStorage: vi.fn(() => new Promise(() => {})), saveRemoteComputer: vi.fn(), deleteRemoteComputer: vi.fn() } as unknown as ApplicationActions

function localSource(change: (computer: ApplicationComputer, source: ApplicationSource) => void = () => {}) {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.devices = []
  source.runtimeRepair = null
  source.computerConfigurationOperation = null
  source.activities = []
  const dev = source.computers.find(({ configuration }) => configuration.name === "dev")!
  Object.assign(dev, { state: "stopped", freshness: "fresh", attention: undefined, lifecycleAction: undefined })
  delete dev.configuration.desktop
  change(dev, source)
  return source
}

async function menuItems(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  const items = screen.getAllByRole("menuitem").map(item => ({ name: item.getAttribute("aria-label") ?? item.textContent, disabled: item.hasAttribute("data-disabled") }))
  await user.keyboard("{Escape}")
  return items
}

function page(source: ApplicationSource) {
  return <OverviewPage source={source} actions={actions} backup={backup} onExportComputer={vi.fn()} onConfigurationsChange={vi.fn()} />
}

it("builds the same ⋯ menu for a computer's row and its page", async () => {
  const user = userEvent.setup()
  render(page(localSource()))
  const row = await menuItems(user)
  await user.click(within(screen.getByText("dev").closest("li")!).getByRole("button", { name: "Open dev" }))
  const detail = await menuItems(user)
  expect(detail).toEqual(row)
  expect(row.map(({ name }) => name)).toEqual(expect.arrayContaining(["Checkpoints for dev", "Storage for dev", "Fork dev", "Export dev", "Edit dev", "Duplicate settings for dev", "Add Linux desktop", "Delete dev"]))
})

it("disables the same mutating items in both menus while a remote device refreshes", async () => {
  const user = userEvent.setup()
  render(page(localSource((computer, source) => {
    computer.device = { id: "office", computerId: "vm", name: "Office", address: "office.test", connected: true, busy: true }
    source.devices = [{ id: "office", name: "Office", address: "office.test", connected: true, busy: true }]
  })))
  const row = await menuItems(user)
  await user.click(within(screen.getByText("dev").closest("li")!).getByRole("button", { name: "Open dev" }))
  expect(await menuItems(user)).toEqual(row)
  for (const name of ["Fork dev", "Edit dev", "Duplicate settings for dev", "Delete dev on Office"]) expect(row.find(item => item.name === name)?.disabled).toBe(true)
  // Opening the Checkpoints tab is navigation, not a change.
  expect(row.find(({ name }) => name === "Checkpoints for dev")?.disabled).toBe(false)
})

it("adds a Linux desktop from the computer page as from the list", async () => {
  const user = userEvent.setup()
  const onConfigurationsChange = vi.fn()
  const source = localSource()
  const dev = source.computers.find(({ configuration }) => configuration.name === "dev")!
  render(<OverviewPage source={source} actions={actions} onConfigurationsChange={onConfigurationsChange} />)
  await user.click(within(screen.getByText("dev").closest("li")!).getByRole("button", { name: "Open dev" }))
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Add Linux desktop" }))
  expect(onConfigurationsChange).toHaveBeenCalledWith(
    expect.arrayContaining([{ ...dev.configuration, desktop: { startWithComputer: true } }]),
    expect.anything(),
  )
})
