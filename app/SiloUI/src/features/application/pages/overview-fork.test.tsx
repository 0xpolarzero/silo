import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import type { OperationQueue } from "../model/operation-queue"
import { Toaster } from "@/components/ui/sonner"
import { OverviewPage } from "./overview-page"
import type { ApplicationWorkspace } from "../model/application-source"

function confirmButton(name: string) { return within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name }) }

it("closes the fork popover at once and continues current-state fork progress in a notification", async () => {
  let finishFork!: () => void
  const forkCheckpoint = vi.fn(() => new Promise<void>(resolve => { finishFork = resolve }))
  const actions = { forkCheckpoint } as unknown as ApplicationActions
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  const view = render(<><OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} /><Toaster /></>)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  fireEvent.change(await screen.findByRole("textbox", { name: "New sandbox name" }), { target: { value: "experiment" } })
  await user.click(screen.getByRole("button", { name: "Fork" }))

  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, null, "experiment"))
  // The popover closed immediately; progress lives in one notification.
  expect(screen.queryByRole("textbox", { name: "New sandbox name" })).toBeNull()
  expect(await screen.findByText("Creating fork experiment")).toBeVisible()
  expect(screen.getByRole("progressbar", { name: "Copying from the checkpoint" })).toBeVisible()

  const progressing = structuredClone(source)
  const progressingWorkspace = progressing.workspaces.find(item => item.machine.id === workspace.machine.id)!
  progressingWorkspace.checkpointOperation = { kind: "fork", status: "running", stage: "copying-disk" }
  view.rerender(<><OverviewPage source={progressing} actions={actions} onMachinesChange={vi.fn()} /><Toaster /></>)
  expect(await screen.findByText("copying-disk", { selector: "[data-sonner-toast] span" })).toBeVisible()
  expect(screen.getAllByText("Creating fork experiment")).toHaveLength(1)

  await act(async () => { finishFork() })
  expect(await screen.findByText("Fork created")).toBeVisible()
  expect(screen.queryByText("Creating fork experiment")).toBeNull()
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
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "pending-fork")
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
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "experiment")
  await user.click(screen.getByRole("button", { name: "Fork" }))
  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "checkpoint-1", "experiment"))

  await user.click(savedRow.getByRole("button", { name: "Restore" }))
  await user.click(confirmButton("Restore"))
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

it("dismisses a sandbox's notifications when it is deleted and announces the deletion", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  const workspace = source.workspaces.find(item => item.machine.kind === "vm" && !item.computer)!
  workspace.state = "stopped"
  const { showOperationSuccess } = await import("@/lib/operation-toast")
  const actions = { forkCheckpoint: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  const onMachinesChange = vi.fn().mockResolvedValue(undefined)
  const view = render(<><OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} /><Toaster /></>)
  act(() => showOperationSuccess("import-result", `Imported ${workspace.machine.name}`, { sandbox: workspace.machine.name, action: { label: "Open", onClick: vi.fn() } }))
  expect(await screen.findByText(`Imported ${workspace.machine.name}`)).toBeVisible()

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(await screen.findByRole("menuitem", { name: `Delete ${workspace.machine.name}` }))
  await user.click(confirmButton("Delete"))
  expect(await screen.findByText(`Deleted ${workspace.machine.name}`)).toBeVisible()

  const remaining = { ...source, workspaces: source.workspaces.filter(item => item.machine.id !== workspace.machine.id) }
  view.rerender(<><OverviewPage source={remaining} actions={actions} onMachinesChange={onMachinesChange} /><Toaster /></>)
  await waitFor(() => expect(screen.queryByText(`Imported ${workspace.machine.name}`)).not.toBeInTheDocument())
  expect(screen.getByText(`Deleted ${workspace.machine.name}`)).toBeVisible()
})

it("moves Cancel for a running checkpoint capture into its progress notification", async () => {
  const { runCheckpointOperation, syncCheckpointProgress } = await import("../model/checkpoint-operation-toast")
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm" && !item.computer)!
  const cancel = vi.fn()
  render(<Toaster />)
  let finish!: () => void
  void runCheckpointOperation({ id: "checkpoint:dev:capture", kind: "capture", target: workspace.machine.name, sandbox: workspace.machine.name, title: "Creating checkpoint “A”", run: () => new Promise<void>(resolve => { finish = resolve }), success: { title: "Checkpoint created" }, failureTitle: "Could not create checkpoint" })
  workspace.checkpointOperation = { kind: "capture", status: "running", stage: "Saving disk copies" }
  const queue: OperationQueue = { running: [{ id: 42, label: "Creating checkpoint", kind: "checkpointCapture", vmId: workspace.machine.id, vmName: workspace.machine.name, sinceMs: Date.now(), cancellable: true, expectedMs: null, blockedByHidden: false }], waiting: [] }
  act(() => syncCheckpointProgress(source.workspaces, { queue, cancel }))
  const button = await screen.findByRole("button", { name: "Cancel" })
  await userEvent.setup().click(button)
  expect(cancel).toHaveBeenCalledWith(42)
  await act(async () => { finish() })
})
