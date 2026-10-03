import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, ComputerState } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const actions = { listComputerDirectory: vi.fn(() => new Promise(() => {})), openEditor: vi.fn() } as unknown as ApplicationActions

function withDevState(source: ApplicationSource, state: ComputerState): ApplicationSource {
  return { ...source, computers: source.computers.map(computer => computer.configuration.name === "dev" ? { ...computer, state } : computer) }
}

it("drops the folder picker when its computer stops instead of reopening it later", async () => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running")
  const view = render(<OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `Open dev in ${source.preferences.editor}` }))
  expect(screen.getByRole("heading", { name: "dev folders" })).toBeVisible()

  view.rerender(<OverviewPage source={withDevState(source, "stopped")} actions={actions} onConfigurationsChange={vi.fn()} />)
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()

  view.rerender(<OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} />)
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()
  expect(screen.getByRole("list", { name: "Configured computers" })).toBeVisible()
})

it("gives way to palette or status-panel navigation to another computer", async () => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running")
  const playgrounds = source.computers.find(({ configuration }) => configuration.name === "playgrounds")!
  const page = (selectedComputerId: string | null) => <OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} selectedComputerId={selectedComputerId} onOpenComputer={vi.fn()} onCloseComputer={vi.fn()} onSelectComputerTab={vi.fn()} />
  const view = render(page(null))
  await user.click(screen.getByRole("button", { name: `Open dev in ${source.preferences.editor}` }))
  expect(screen.getByRole("heading", { name: "dev folders" })).toBeVisible()

  view.rerender(page(playgrounds.configuration.id))
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Computersplaygrounds")

  // Returning to the list does not bring the stale picker back either.
  view.rerender(page(null))
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()
})
