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

it("offers a Retry action on a failed restart that re-submits the same intent", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.lifecycleFailure = "Restart failed: Starting dev was cancelled."
  workspace.lifecycleFailureAction = "restart"
  const actions = { restartWorkspace: vi.fn() } as unknown as ApplicationActions
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  await userEvent.setup().click(row.getByRole("button", { name: "Retry" }))
  expect(actions.restartWorkspace).toHaveBeenCalledWith("dev")
})

it("shows what a queued lifecycle action is waiting for until its turn to run", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.lifecycleAction = "stop"
  const vmId = workspace.machine.id
  source.operationQueue = {
    running: [{ id: 1, label: "Backing up sandboxes", vmId: null, vmName: null, sinceMs: 0, cancellable: true, expectedMs: null, blockedByHidden: false }],
    waiting: [{ id: 2, label: "Stop dev", vmId, vmName: "dev", sinceMs: 0, cancellable: true, expectedMs: null, blockedByHidden: false }],
  }
  const actions = { cancelOperation: vi.fn() } as unknown as ApplicationActions
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByRole("status")).toHaveTextContent("Waiting for Backing up sandboxes…")
  expect(row.queryByText("Stopping…")).not.toBeInTheDocument()
  // Once the entry is admitted (running, no longer waiting) the row shows the action.
  source.operationQueue = {
    running: [{ id: 2, label: "Stop dev", vmId, vmName: "dev", sinceMs: 0, cancellable: false, expectedMs: null, blockedByHidden: false }],
    waiting: [],
  }
  view.rerender(<OverviewPage source={structuredClone(source)} actions={actions} onMachinesChange={vi.fn()} />)
  expect(row.getByRole("status")).toHaveTextContent("Stopping…")
  expect(row.queryByText(/Waiting for/)).not.toBeInTheDocument()
})

it("shows a cancelled lifecycle action as a neutral, retryable state, not an error", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.state = "running"
  workspace.lifecycleFailure = "The operation was cancelled."
  workspace.lifecycleFailureAction = "stop"
  workspace.lifecycleFailureCancelled = true
  const actions = { stopWorkspace: vi.fn() } as unknown as ApplicationActions
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.queryByRole("alert")).not.toBeInTheDocument()
  expect(row.getByText("Stop cancelled")).toBeVisible()
  await userEvent.setup().click(row.getByRole("button", { name: "Retry" }))
  expect(actions.stopWorkspace).toHaveBeenCalledWith("dev")
})

it("keeps a known lifecycle action visible while its remote computer refreshes status", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.computer = { id: "office", name: "Office", address: "office.example", connected: true, busy: true, vmId: workspace.machine.id }
  workspace.freshness = "stale"
  workspace.lifecycleAction = "start"
  const actions = {} as ApplicationActions
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByRole("status")).toHaveTextContent("Starting…")

  delete workspace.lifecycleAction
  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  expect(row.getByRole("status")).toHaveTextContent("Refreshing status…")
  expect(row.queryByText(/Applying VM changes/)).not.toBeInTheDocument()
})
