import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, WorkspaceState } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const actions = { listWorkspaceDirectory: vi.fn(() => new Promise(() => {})), openEditor: vi.fn() } as unknown as ApplicationActions

function withDevState(source: ApplicationSource, state: WorkspaceState): ApplicationSource {
  return { ...source, workspaces: source.workspaces.map(workspace => workspace.machine.name === "dev" ? { ...workspace, state } : workspace) }
}

it("drops the folder picker when its sandbox stops instead of reopening it later", async () => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running")
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `Open dev in ${source.preferences.editor}` }))
  expect(screen.getByRole("heading", { name: "dev folders" })).toBeVisible()

  view.rerender(<OverviewPage source={withDevState(source, "stopped")} actions={actions} onMachinesChange={vi.fn()} />)
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()

  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()
  expect(screen.getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
})

it("gives way to palette or status-panel navigation to another sandbox", async () => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running")
  const playgrounds = source.workspaces.find(({ machine }) => machine.name === "playgrounds")!
  const page = (selectedSandboxId: string | null) => <OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} selectedSandboxId={selectedSandboxId} onOpenSandbox={vi.fn()} onCloseSandbox={vi.fn()} onSelectSandboxTab={vi.fn()} />
  const view = render(page(null))
  await user.click(screen.getByRole("button", { name: `Open dev in ${source.preferences.editor}` }))
  expect(screen.getByRole("heading", { name: "dev folders" })).toBeVisible()

  view.rerender(page(playgrounds.machine.id))
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesplaygrounds")

  // Returning to the list does not bring the stale picker back either.
  view.rerender(page(null))
  expect(screen.queryByRole("heading", { name: "dev folders" })).not.toBeInTheDocument()
})
