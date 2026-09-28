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

it("flags a long-running operation as possibly stuck", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = {
    running: [{ id: 1, label: "Backing up dev-vm", vmId: "00000000-0000-4000-8000-000000000001", vmName: "dev", sinceMs: Date.now() - 12 * 60_000 }],
    waiting: [],
  }
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  const indicator = screen.getByRole("status", { name: "Sandbox operations" })
  const elapsed = within(indicator).getByText("12 min")
  expect(elapsed).toHaveAttribute("title", expect.stringContaining("stuck"))
})

it("renders nothing when the queue is empty", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = { running: [], waiting: [] }
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  expect(screen.queryByRole("status", { name: "Sandbox operations" })).not.toBeInTheDocument()
})
