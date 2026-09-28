import { render, screen, within } from "@testing-library/react"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { fixtureOperationQueue } from "@/fixtures/operation-queue"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const actions = {} as ApplicationActions

it("shows what a waiting sandbox operation is waiting for, near that sandbox", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = fixtureOperationQueue()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByText("Waiting for Backing up sandboxes…")).toBeVisible()
})

it("lists running and waiting operations in a global indicator with elapsed time", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = fixtureOperationQueue()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  const indicator = screen.getByRole("status", { name: "Sandbox operations" })
  expect(within(indicator).getByText("Backing up sandboxes")).toBeVisible()
  expect(within(indicator).getByText("3 min")).toBeVisible()
  expect(within(indicator).getByText("Restarting dev")).toBeVisible()
  expect(within(indicator).getAllByText("Waiting for Backing up sandboxes…").length).toBeGreaterThanOrEqual(1)
})

it("flags an operation past its expected duration as taking longer than expected", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = {
    running: [{ id: 1, label: "Backing up dev-vm", vmId: "00000000-0000-4000-8000-000000000001", vmName: "dev", sinceMs: Date.now() - 6 * 60_000, cancellable: false, expectedMs: 5 * 60_000 }],
    waiting: [],
  }
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  const indicator = screen.getByRole("status", { name: "Sandbox operations" })
  expect(within(indicator).getByText("Taking longer than expected")).toBeVisible()
})

it("does not flag an operation that is within its expected duration", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = {
    running: [{ id: 1, label: "Backing up dev-vm", vmId: "00000000-0000-4000-8000-000000000001", vmName: "dev", sinceMs: Date.now() - 6 * 60_000, cancellable: false, expectedMs: 60 * 60_000 }],
    waiting: [],
  }
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  expect(screen.queryByText("Taking longer than expected")).not.toBeInTheDocument()
})

it("offers Cancel for a cancellable running operation and invokes cancelOperation", async () => {
  const user = (await import("@testing-library/user-event")).default.setup()
  const cancelOperation = vi.fn()
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = {
    running: [{ id: 7, label: "Starting dev", vmId: "00000000-0000-4000-8000-000000000001", vmName: "dev", sinceMs: Date.now(), cancellable: true, expectedMs: 3 * 60_000 }],
    waiting: [],
  }
  render(<OverviewPage source={source} actions={{ ...actions, cancelOperation } as ApplicationActions} onMachinesChange={vi.fn()} />)

  const indicator = screen.getByRole("status", { name: "Sandbox operations" })
  await user.click(within(indicator).getByRole("button", { name: "Cancel Starting dev" }))
  expect(cancelOperation).toHaveBeenCalledWith(7)
})

it("does not offer Cancel for a non-cancellable running operation", () => {
  const cancelOperation = vi.fn()
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = {
    running: [{ id: 8, label: "Stopping dev", vmId: "00000000-0000-4000-8000-000000000001", vmName: "dev", sinceMs: Date.now(), cancellable: false, expectedMs: 2 * 60_000 }],
    waiting: [],
  }
  render(<OverviewPage source={source} actions={{ ...actions, cancelOperation } as ApplicationActions} onMachinesChange={vi.fn()} />)

  const indicator = screen.getByRole("status", { name: "Sandbox operations" })
  expect(within(indicator).queryByRole("button", { name: "Cancel Stopping dev" })).not.toBeInTheDocument()
})

it("renders nothing when the queue is empty", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = { running: [], waiting: [] }
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  expect(screen.queryByRole("status", { name: "Sandbox operations" })).not.toBeInTheDocument()
})
