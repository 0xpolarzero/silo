import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, ApplicationComputer } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function sourceWith(change: (computer: ApplicationComputer) => void): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.devices = []
  change(source.computers.find(({ configuration }) => configuration.name === "dev")!)
  return source
}

it.each([
  ["a lifecycle action runs", (computer: ApplicationComputer) => { computer.lifecycleAction = "start" }],
  ["a checkpoint operation runs", (computer: ApplicationComputer) => { computer.checkpointOperation = { status: "running", kind: "capture", stage: "Saving disk copies" } as ApplicationComputer["checkpointOperation"] }],
  ["its device is refreshing", (computer: ApplicationComputer) => { computer.device = { id: "office", computerId: "vm-1", name: "Office", address: "office.test", connected: true, busy: true } }],
  ["its device is offline", (computer: ApplicationComputer) => { computer.device = { id: "office", computerId: "vm-1", name: "Office", address: "office.test", connected: false }; computer.freshness = "stale" }],
])("keeps the computer page reachable while %s, with mutating controls disabled", async (_, change) => {
  const user = userEvent.setup()
  const source = sourceWith(change)
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onConfigurationsChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  // Remote rows reorder too (this device keeps its own order), but not while work runs.
  expect(row.getByRole("button", { name: "Reorder dev" })).toHaveAttribute("aria-disabled", "true")
  await user.click(row.getByRole("button", { name: "More actions for dev" }))
  expect(screen.getByRole("menuitem", { name: "Edit dev" })).toHaveAttribute("data-disabled")
  await user.keyboard("{Escape}")

  await user.click(row.getByRole("button", { name: "Open dev" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Computersdev")
})

it("does not offer a page for a computer that is still being created", () => {
  const source = structuredClone(applicationSourceForScenario("running", undefined, undefined, "add-configuring"))
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onConfigurationsChange={vi.fn()} />)
  const added = source.computerConfigurationOperation!.candidate.computers.find(({ id }) => !source.computers.some(({ configuration }) => configuration.id === id))!
  const row = within(screen.getByText(added.name).closest("li")!)
  expect(row.queryByRole("button", { name: `Open ${added.name}` })).not.toBeInTheDocument()
})
