import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupController } from "../model/backup-source"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const backup = { state: { snapshotId: "1", availability: "available", archives: [], operation: null }, actions: {} } as unknown as BackupController

function setup(desktop: boolean) {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.devices = []
  source.runtimeRepair = null
  source.computerConfigurationOperation = null
  source.activities = []
  const dev = source.computers.find(({ configuration }) => configuration.name === "dev")!
  Object.assign(dev, { state: "stopped", freshness: "fresh", attention: undefined, lifecycleAction: undefined })
  if (desktop) dev.configuration.desktop = { startWithComputer: true }
  else delete dev.configuration.desktop
  const openDesktop = vi.fn()
  const actions = { openDesktop, readWorkspaceStorage: vi.fn(() => new Promise(() => {})) } as unknown as ApplicationActions
  render(<OverviewPage source={source} actions={actions} backup={backup} onExportComputer={vi.fn()} onConfigurationsChange={vi.fn()} />)
  return { openDesktop }
}

it("opens the Linux desktop from an icon on the row and on the page", async () => {
  const user = userEvent.setup()
  const { openDesktop } = setup(true)
  const row = within(screen.getByText("dev").closest("li")!)
  await user.click(row.getByRole("button", { name: "Open dev desktop" }))
  expect(openDesktop).toHaveBeenCalledTimes(1)
  await user.click(row.getByRole("button", { name: "Open dev" }))
  await user.click(screen.getByRole("button", { name: "Open dev desktop" }))
  expect(openDesktop).toHaveBeenCalledTimes(2)
  expect(openDesktop.mock.calls[1]).toEqual(openDesktop.mock.calls[0])
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  expect(screen.queryByRole("menuitem", { name: "Open dev desktop" })).not.toBeInTheDocument()
})

it("offers no desktop icon for a computer without a Linux desktop", async () => {
  const user = userEvent.setup()
  setup(false)
  expect(screen.queryByRole("button", { name: "Open dev desktop" })).not.toBeInTheDocument()
  await user.click(within(screen.getByText("dev").closest("li")!).getByRole("button", { name: "Open dev" }))
  expect(screen.queryByRole("button", { name: "Open dev desktop" })).not.toBeInTheDocument()
})
