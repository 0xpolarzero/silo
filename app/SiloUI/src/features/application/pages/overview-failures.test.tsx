import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const page = (source: ReturnType<typeof applicationSourceForScenario>, actions: ApplicationActions) =>
  <><Toaster /><OverviewPage source={structuredClone(source)} actions={actions} onConfigurationsChange={vi.fn()} /></>

it("toasts a new lifecycle failure without inserting it in the row, and keeps Start available", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.state = "stopped"
  computer.stateDetail = "Stopped"
  const actions = { startComputer: vi.fn() } as unknown as ApplicationActions
  const view = render(page(source, actions))
  computer.lifecycleFailure = "Start failed: libkrunfw could not load\nThe library signature was rejected."
  computer.lifecycleFailureAction = "start"
  view.rerender(page(source, actions))
  const row = within(screen.getByText("dev").closest("li")!)
  expect(await screen.findByText("Could not start dev")).toBeVisible()
  expect(screen.getByText(/The library signature was rejected/)).toBeVisible()
  expect(row.queryByRole("alert")).not.toBeInTheDocument()
  expect(row.getByRole("button", { name: "Start dev" })).toBeEnabled()
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
  expect(actions.startComputer).toHaveBeenCalledWith("dev")
})

it("does not toast a lifecycle failure already present at first load", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.lifecycleFailure = "Start failed: earlier"
  computer.lifecycleFailureAction = "start"
  render(page(source, {} as ApplicationActions))
  expect(screen.queryByText("Could not start dev")).not.toBeInTheDocument()
})

it("offers a Retry action on a failed restart that re-submits the same intent", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  const actions = { restartComputer: vi.fn() } as unknown as ApplicationActions
  const view = render(page(source, actions))
  computer.lifecycleFailure = "Restart failed: Starting dev was cancelled."
  computer.lifecycleFailureAction = "restart"
  view.rerender(page(source, actions))
  expect(await screen.findByText("Could not restart dev")).toBeVisible()
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
  expect(actions.restartComputer).toHaveBeenCalledWith("dev")
})

it("shows what a queued lifecycle action is waiting for until its turn to run", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.lifecycleAction = "stop"
  const computerId = computer.configuration.id
  source.operationQueue = {
    running: [{ id: 1, label: "Backing up computers", kind: "other", computerId: null, computerName: null, sinceMs: 0, cancellable: true, expectedMs: null, blockedByHidden: false }],
    waiting: [{ id: 2, label: "Stop dev", kind: "lifecycle", computerId, computerName: "dev", sinceMs: 0, cancellable: true, expectedMs: null, blockedByHidden: false }],
  }
  const actions = { cancelOperation: vi.fn() } as unknown as ApplicationActions
  const view = render(<><Toaster /><OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} /></>)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByRole("status")).toHaveTextContent("Waiting for Backing up computers…")
  expect(row.queryByText("Stopping…")).not.toBeInTheDocument()
  // Once the entry is admitted (running, no longer waiting) the row shows the action.
  source.operationQueue = {
    running: [{ id: 2, label: "Stop dev", kind: "lifecycle", computerId, computerName: "dev", sinceMs: 0, cancellable: false, expectedMs: null, blockedByHidden: false }],
    waiting: [],
  }
  view.rerender(<><Toaster /><OverviewPage source={structuredClone(source)} actions={actions} onConfigurationsChange={vi.fn()} /></>)
  expect(row.getByRole("status")).toHaveTextContent("Stopping…")
  expect(row.queryByText(/Waiting for/)).not.toBeInTheDocument()
})

it("reports a cancelled lifecycle action as a neutral toast, not an error", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.state = "running"
  const actions = {} as ApplicationActions
  const view = render(page(source, actions))
  computer.lifecycleFailure = "The operation was cancelled."
  computer.lifecycleFailureAction = "stop"
  computer.lifecycleFailureCancelled = true
  view.rerender(page(source, actions))
  expect(await screen.findByText("Stop cancelled")).toBeVisible()
  expect(screen.queryByText("Could not stop dev")).not.toBeInTheDocument()
  expect(within(screen.getByText("dev").closest("li")!).queryByRole("alert")).not.toBeInTheDocument()
})

it("keeps a known lifecycle action visible while its remote device refreshes status", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.device = { id: "office", name: "Office", address: "office.example", connected: true, busy: true, computerId: computer.configuration.id }
  computer.freshness = "stale"
  computer.lifecycleAction = "start"
  const actions = {} as ApplicationActions
  const view = render(<><Toaster /><OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} /></>)
  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByRole("status")).toHaveTextContent("Starting…")

  delete computer.lifecycleAction
  view.rerender(<><Toaster /><OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} /></>)
  expect(row.getByRole("status")).toHaveTextContent("Updating…")
  expect(row.getAllByText("Updating…")).toHaveLength(1)
})

it("shows a lifecycle progress notification only for actions slower than the debounce, then dismisses it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const source = structuredClone(applicationSourceForScenario("complete"))
    const computer = source.computers.find(item => item.configuration.name === "dev")!
    computer.state = "stopped"
    const actions = {} as ApplicationActions
    const view = render(page(source, actions))

    // An instant action never flashes a notification.
    computer.lifecycleAction = "stop"
    view.rerender(page(source, actions))
    delete computer.lifecycleAction
    view.rerender(page(source, actions))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.queryByText("Stopping dev")).toBeNull()

    computer.lifecycleAction = "stop"
    view.rerender(page(source, actions))
    expect(screen.queryByText("Stopping dev")).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(await screen.findByText("Stopping dev")).toBeVisible()

    delete computer.lifecycleAction
    view.rerender(page(source, actions))
    await waitFor(() => expect(screen.queryByText("Stopping dev")).toBeNull())
    // A start is never instant, so its notification appears at once.
    computer.lifecycleAction = "start"
    view.rerender(page(source, actions))
    expect(await screen.findByText("Starting dev")).toBeVisible()
    delete computer.lifecycleAction
    view.rerender(page(source, actions))
    await waitFor(() => expect(screen.queryByText("Starting dev")).toBeNull())
  } finally {
    vi.useRealTimers()
  }
})
