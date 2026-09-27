import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
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

it("opens checkpoints from the Overview menu and exposes create, fork, and restore progress", async () => {
  let finishCreate!: () => void
  let finishFork!: () => void
  let finishRestore!: () => void
  const createCheckpoint = vi.fn(() => new Promise<void>(resolve => { finishCreate = resolve }))
  const forkCheckpoint = vi.fn(() => new Promise<void>(resolve => { finishFork = resolve }))
  const restoreCheckpoint = vi.fn(() => new Promise<void>(resolve => { finishRestore = resolve }))
  const actions = { createCheckpoint, forkCheckpoint, restoreCheckpoint } as unknown as ApplicationActions
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.checkpoints = [{ id: "checkpoint-1", name: "Before deploy", createdAt: "2026-09-25T10:00:00.000Z", scope: "full", reason: "manual" }] satisfies NonNullable<ApplicationWorkspace["checkpoints"]>
  const user = userEvent.setup()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Checkpoints for ${workspace.machine.name}` }))
  const panel = within(screen.getByRole("region", { name: `Checkpoints for ${workspace.machine.name}` }))
  expect(panel.queryByRole("button", { name: "Fork current state" })).not.toBeInTheDocument()
  expect(panel.getByRole("button", { name: "Fork" })).toBeVisible()
  expect(panel.getByRole("button", { name: "Restore" })).toBeVisible()

  await user.click(panel.getByRole("button", { name: "Fork" }))
  const forkPopover = within(screen.getByRole("dialog", { name: "Create stopped fork" }))
  await user.type(forkPopover.getByRole("textbox", { name: "Fork name" }), "experiment")
  await user.click(forkPopover.getByRole("button", { name: "Create fork" }))
  expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "checkpoint-1", "experiment")

  const showSingleRowProgress = (kind: "capture" | "fork" | "restore", stage: string) => {
    const progressing = structuredClone(source)
    progressing.workspaces.find(item => item.machine.id === workspace.machine.id)!.checkpointOperation = { kind, status: "running", stage }
    view.rerender(<OverviewPage source={progressing} actions={actions} onMachinesChange={vi.fn()} />)
    expect(panel.queryByRole("status")).not.toBeInTheDocument()
    expect(panel.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.getAllByRole("progressbar")).toHaveLength(1)
    expect(screen.getByRole("progressbar", { name: "Checkpoint operation progress" })).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent(stage)
  }
  showSingleRowProgress("fork", "Copying saved checkpoint")
  finishFork()
  view.rerender(<OverviewPage source={structuredClone(source)} actions={actions} onMachinesChange={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole("region", { name: `Checkpoints for ${workspace.machine.name}` })).not.toHaveAttribute("aria-busy"))

  await user.click(panel.getByRole("button", { name: "Restore" }))
  expect(panel.getByRole("button", { name: "Confirm restore" })).toBeVisible()
  await user.click(panel.getByRole("button", { name: "Confirm restore" }))
  expect(restoreCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "checkpoint-1")
  showSingleRowProgress("restore", "Saving recovery point and restoring")
  finishRestore()
  view.rerender(<OverviewPage source={structuredClone(source)} actions={actions} onMachinesChange={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole("region", { name: `Checkpoints for ${workspace.machine.name}` })).not.toHaveAttribute("aria-busy"))

  await user.type(panel.getByRole("textbox", { name: "Checkpoint name" }), "After deploy")
  await user.click(panel.getByRole("button", { name: "Create" }))
  expect(createCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "After deploy")
  expect(panel.getByRole("button", { name: "Create" })).toBeDisabled()
  showSingleRowProgress("capture", "Creating checkpoint")
  finishCreate()
  view.rerender(<OverviewPage source={structuredClone(source)} actions={actions} onMachinesChange={vi.fn()} />)
})
