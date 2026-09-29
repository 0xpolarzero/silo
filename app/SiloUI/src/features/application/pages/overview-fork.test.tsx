import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { Toaster } from "@/components/ui/sonner"
import { OverviewPage } from "./overview-page"
import type { ApplicationWorkspace } from "../model/application-source"

it("keeps current-state fork progress visible when launched from a sandbox menu", async () => {
  let finishFork!: () => void
  const forkCheckpoint = vi.fn(() => new Promise<void>(resolve => { finishFork = resolve }))
  const actions = { forkCheckpoint } as unknown as ApplicationActions
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  fireEvent.change(screen.getByRole("textbox", { name: "New sandbox name" }), { target: { value: "experiment" } })
  await user.click(screen.getByRole("button", { name: "Fork" }))

  expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, null, "experiment")
  expect(screen.getByRole("progressbar", { name: "Fork progress" })).toBeVisible()
  const dialog = within(screen.getByRole("dialog"))
  expect(dialog.getByRole("status")).toHaveTextContent("Creating fork…")
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()

  const progressing = structuredClone(source)
  const progressingWorkspace = progressing.workspaces.find(item => item.machine.id === workspace.machine.id)!
  progressingWorkspace.checkpointOperation = { kind: "fork", status: "running", stage: "copying-disk" }
  view.rerender(<OverviewPage source={progressing} actions={actions} onMachinesChange={vi.fn()} />)
  expect(dialog.getByRole("status")).toHaveTextContent("copying-disk")

  finishFork()
})

it("allows current-state Fork for a pending restored sandbox without starting it", async () => {
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  const startWorkspace = vi.fn()
  const actions = { forkCheckpoint, startWorkspace } as unknown as ApplicationActions
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.state = "stopped"
  workspace.stateDetail = "Ready to start from checkpoint"
  workspace.pendingCheckpointRestore = { checkpointId: "saved-point", sourceWorkspace: "dev", state: "full" }
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  await user.type(screen.getByRole("textbox", { name: "New sandbox name" }), "pending-fork")
  await user.click(screen.getByRole("button", { name: "Fork" }))

  expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, null, "pending-fork")
  expect(startWorkspace).not.toHaveBeenCalled()
})

it("shows persisted checkpoint progress and locks the workspace row after remount", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.checkpointOperation = { kind: "capture", status: "running", stage: "Capturing VM state" }
  render(<OverviewPage source={source} actions={{ forkCheckpoint: vi.fn() } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)

  expect(screen.getByRole("status")).toHaveTextContent("Capturing VM state")
  expect(screen.getByRole("progressbar", { name: "Checkpoint operation progress" })).toBeVisible()
  expect(document.querySelector(`[data-machine-id="${workspace.machine.id}"]`)).toHaveAttribute("aria-busy", "true")
  expect(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` })).toBeDisabled()
})

it("opens the Checkpoints tab from the Overview menu and drives fork, restore, and create", async () => {
  const createCheckpoint = vi.fn().mockResolvedValue(undefined)
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
  const actions = { createCheckpoint, forkCheckpoint, restoreCheckpoint } as unknown as ApplicationActions
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.checkpoints = [{ id: "checkpoint-1", name: "Before deploy", createdAt: "2026-09-25T10:00:00.000Z", scope: "full", reason: "manual" }] satisfies NonNullable<ApplicationWorkspace["checkpoints"]>
  const user = userEvent.setup()
  render(<><OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} /><Toaster /></>)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Checkpoints for ${workspace.machine.name}` }))
  const panel = within(screen.getByRole("region", { name: `Checkpoints for ${workspace.machine.name}` }))
  const savedRow = within(panel.getByText("Before deploy").closest("[data-checkpoint-name]")!)
  expect(savedRow.getByRole("button", { name: "Restore" })).toBeVisible()

  await user.click(savedRow.getByRole("button", { name: "Checkpoint actions for Before deploy" }))
  await user.click(screen.getByRole("menuitem", { name: "Fork Before deploy" }))
  const forkDialog = within(screen.getByRole("dialog", { name: "Fork from “Before deploy”" }))
  await user.type(forkDialog.getByRole("textbox", { name: "New sandbox name" }), "experiment")
  await user.click(forkDialog.getByRole("button", { name: "Fork" }))
  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "checkpoint-1", "experiment"))

  await user.click(savedRow.getByRole("button", { name: "Restore" }))
  await user.click(within(screen.getByRole("dialog", { name: "Restore “Before deploy”" })).getByRole("button", { name: "Restore" }))
  await waitFor(() => expect(restoreCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "checkpoint-1"))

  await user.click(panel.getByRole("button", { name: "New checkpoint" }))
  await user.clear(screen.getByRole("textbox", { name: "Checkpoint name" }))
  await user.type(screen.getByRole("textbox", { name: "Checkpoint name" }), "After deploy")
  await user.click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(createCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "After deploy"))

  // Create progress and completion are notifications, not inline blocks that push the list.
  expect(await screen.findByText("Checkpoint created")).toBeVisible()
  expect(screen.queryByRole("progressbar", { name: "Checkpoint operation progress" })).not.toBeInTheDocument()
})
