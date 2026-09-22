import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"

it("shows a stopped sandbox's failure immediately and keeps Start available for retry", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.state = "stopped"
  workspace.stateDetail = "Stopped"
  workspace.lifecycleFailure = "Start failed: libkrunfw could not load\nThe library signature was rejected."
  const actions = { startWorkspace: vi.fn() } as unknown as ApplicationActions
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByRole("alert")).toHaveTextContent("The library signature was rejected.")
  expect(row.getByText("Stopped")).toBeVisible()
  expect(row.getByRole("button", { name: "Start dev" })).toBeEnabled()
  await userEvent.setup().click(row.getByRole("button", { name: "Start dev" }))
  expect(actions.startWorkspace).toHaveBeenCalledWith("dev")
  view.rerender(<OverviewPage source={structuredClone(source)} actions={actions} onMachinesChange={vi.fn()} />)
  expect(row.getByRole("alert")).toHaveTextContent("libkrunfw could not load")
  delete workspace.lifecycleFailure
  workspace.state = "running"
  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  expect(row.queryByRole("alert")).not.toBeInTheDocument()
})
