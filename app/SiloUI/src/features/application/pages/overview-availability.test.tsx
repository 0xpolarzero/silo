import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function sourceWith(change: (workspace: ApplicationWorkspace) => void): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  source.runtimeRepair = null
  source.sandboxConfigurationOperation = null
  source.activities = []
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  Object.assign(dev, { state: "running", freshness: "fresh", attention: undefined, lifecycleAction: undefined })
  change(dev)
  return source
}

const editor = applicationSourceForScenario("complete").preferences.editor
const terminal = applicationSourceForScenario("complete").preferences.terminal

async function reasonFor(user: ReturnType<typeof userEvent.setup>, control: HTMLElement) {
  expect(control).toBeDisabled()
  await user.hover(control.closest<HTMLElement>("[data-disabled-reason]")!)
  return (await screen.findByRole("tooltip")).textContent
}

it("explains the sandbox page's disabled Terminal, Editor and Start controls", async () => {
  const user = userEvent.setup()
  render(<OverviewPage source={sourceWith(workspace => { workspace.state = "stopped" })} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Open dev" }))
  const header = within(screen.getByRole("navigation", { name: "Breadcrumb" }).parentElement!.parentElement!)

  expect(await reasonFor(user, header.getByRole("button", { name: `Open dev in ${terminal}` }))).toContain("Start dev to open it.")
  await user.unhover(header.getByRole("button", { name: `Open dev in ${terminal}` }).closest<HTMLElement>("[data-disabled-reason]")!)
  expect(header.getByRole("button", { name: `Open dev in ${editor}` })).toBeDisabled()
  expect(header.getByRole("button", { name: "Start dev" })).toBeEnabled()
})

it("offers Start for a crashed sandbox on the page as in the list", async () => {
  const user = userEvent.setup()
  render(<OverviewPage source={sourceWith(workspace => { workspace.state = "failed"; workspace.attention = { level: "error", message: "The sandbox runtime crashed. Restart it to retry." } })} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByRole("button", { name: "Start dev" })).toBeEnabled()
  await user.click(row.getByRole("button", { name: "Open dev" }))
  expect(screen.getByRole("button", { name: "Start dev" })).toBeEnabled()
})

it("disables Stop while the sandbox is still starting, in the list and on the page, with the reason", async () => {
  const user = userEvent.setup()
  render(<OverviewPage source={sourceWith(workspace => { workspace.state = "starting"; workspace.stateDetail = "Starting" })} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(await reasonFor(user, row.getByRole("button", { name: "Stop dev" }))).toContain("Wait for dev to finish starting.")
  await user.click(row.getByRole("button", { name: "Open dev" }))
  expect(screen.getByRole("button", { name: "Stop dev" })).toBeDisabled()
})
