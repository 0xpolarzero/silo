import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function sourceWith(change: (workspace: ApplicationWorkspace) => void): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  change(source.workspaces.find(({ machine }) => machine.name === "dev")!)
  return source
}

it.each([
  ["a lifecycle action runs", (workspace: ApplicationWorkspace) => { workspace.lifecycleAction = "start" }],
  ["a checkpoint operation runs", (workspace: ApplicationWorkspace) => { workspace.checkpointOperation = { status: "running", kind: "capture", stage: "Saving disk copies" } as ApplicationWorkspace["checkpointOperation"] }],
  ["its computer is refreshing", (workspace: ApplicationWorkspace) => { workspace.computer = { id: "office", vmId: "vm-1", name: "Office", address: "office.test", connected: true, busy: true } }],
  ["its computer is offline", (workspace: ApplicationWorkspace) => { workspace.computer = { id: "office", vmId: "vm-1", name: "Office", address: "office.test", connected: false }; workspace.freshness = "stale" }],
])("keeps the sandbox page reachable while %s, with mutating controls disabled", async (_, change) => {
  const user = userEvent.setup()
  const source = sourceWith(change)
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  // Remote rows reorder too (this computer keeps its own order), but not while work runs.
  expect(row.getByRole("button", { name: "Reorder dev" })).toHaveAttribute("aria-disabled", "true")
  await user.click(row.getByRole("button", { name: "More actions for dev" }))
  expect(screen.getByRole("menuitem", { name: "Edit dev" })).toHaveAttribute("data-disabled")
  await user.keyboard("{Escape}")

  await user.click(row.getByRole("button", { name: "Open dev" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesdev")
})

it("does not offer a page for a sandbox that is still being created", () => {
  const source = structuredClone(applicationSourceForScenario("running", undefined, undefined, "add-configuring"))
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)
  const added = source.sandboxConfigurationOperation!.candidate.machines.find(({ id }) => !source.workspaces.some(({ machine }) => machine.id === id))!
  const row = within(screen.getByText(added.name).closest("li")!)
  expect(row.queryByRole("button", { name: `Open ${added.name}` })).not.toBeInTheDocument()
})
