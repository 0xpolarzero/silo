import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import type { ApplicationActions, ApplicationWorkspace } from "@/features/application/model/application-source"
import { CheckpointPanel } from "./checkpoint-panel"

const workspace = {
  machine: { id: "vm-dev", name: "dev", kind: "vm" },
  checkpoints: [{ id: "point-1", name: "Before refactor", createdAt: "2026-09-25T10:00:00Z", scope: "full", reason: "manual" }],
} as ApplicationWorkspace

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it("offers Fork, Restore and Export on a local checkpoint and reports the checkpoint on export", () => {
  const onExport = vi.fn()
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint: vi.fn(), restoreCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} onExport={onExport} />)
  const row = screen.getByText("Before refactor").closest("li")!
  const buttons = within(row).getAllByRole("button").map((button) => button.textContent)
  expect(buttons).toEqual(["Fork", "Restore", "Export"])
  fireEvent.click(within(row).getByRole("button", { name: "Export" }))
  expect(onExport).toHaveBeenCalledWith(workspace.checkpoints![0])
})

it("hides Export for a remote sandbox checkpoint", () => {
  const remote = { ...workspace, computer: { id: "mac", name: "Ada’s Mac mini", connected: true } } as ApplicationWorkspace
  render(<CheckpointPanel workspace={remote} target="dev" actions={{ forkCheckpoint: vi.fn(), restoreCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} onExport={vi.fn()} />)
  const row = screen.getByText("Before refactor").closest("li")!
  expect(within(row).queryByRole("button", { name: "Export" })).toBeNull()
})

it("disables Export while a transfer is running", () => {
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint: vi.fn(), restoreCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} onExport={vi.fn()} exportDisabled />)
  const row = screen.getByText("Before refactor").closest("li")!
  expect(within(row).getByRole("button", { name: "Export" })).toBeDisabled()
})

it("shows short restore guidance and inline cancel/confirm controls", async () => {
  const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ restoreCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.focus(screen.getByRole("button", { name: "Restore" }))
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Save a recovery checkpoint, then restore this state. The sandbox stays stopped.")
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  expect(screen.getByRole("button", { name: "Confirm restore" })).toBeVisible()
  expect(screen.getByText("Before refactor")).toBeVisible()
  expect(restoreCheckpoint).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(restoreCheckpoint).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Restore" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("button", { name: "Confirm restore" })).toBeNull()
})

it("uses a compact popover to name a stopped fork from the selected checkpoint", async () => {
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  const savedCheckpoint = screen.getByText("Before refactor").closest("li")!
  fireEvent.click(within(savedCheckpoint).getByRole("button", { name: "Fork" }))
  expect(await screen.findByText("Create stopped fork")).toBeVisible()
  expect(screen.getByRole("dialog", { name: "Create stopped fork" })).toBeVisible()
  expect(screen.getByRole("textbox", { name: "Fork name" })).toBeVisible()
  fireEvent.change(screen.getByRole("textbox", { name: "Fork name" }), { target: { value: "experiment" } })
  fireEvent.submit(screen.getByRole("textbox", { name: "Fork name" }).closest("form")!)
  expect(forkCheckpoint).toHaveBeenCalledWith("dev", "point-1", "experiment")
})

it("preserves the checkpoint name draft when a fork is created", async () => {
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint, createCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Checkpoint name" }), { target: { value: "keep this draft" } })
  fireEvent.click(screen.getByRole("button", { name: "Fork" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Fork name" }), { target: { value: "experiment" } })
  fireEvent.click(screen.getByRole("button", { name: "Create fork" }))
  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledOnce())
  expect(screen.getByRole("textbox", { name: "Checkpoint name" })).toHaveValue("keep this draft")
})

it("keeps the panel busy without duplicating fork progress while creation is pending", async () => {
  const task = deferred()
  const forkCheckpoint = vi.fn(() => task.promise)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.click(screen.getByRole("button", { name: "Fork" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Fork name" }), { target: { value: "experiment" } })
  fireEvent.click(screen.getByRole("button", { name: "Create fork" }))
  expect(screen.getByRole("region", { name: "Checkpoints for dev" })).toHaveAttribute("aria-busy", "true")
  expect(screen.queryByRole("status")).toBeNull()
  expect(screen.queryByRole("progressbar")).toBeNull()
  task.resolve()
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
})

it("keeps the panel busy without duplicating checkpoint progress while creation is pending", async () => {
  const task = deferred()
  const createCheckpoint = vi.fn(() => task.promise)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ createCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Checkpoint name" }), { target: { value: "before deploy" } })
  fireEvent.click(screen.getByRole("button", { name: "Create" }))
  expect(screen.getByRole("region", { name: "Checkpoints for dev" })).toHaveAttribute("aria-busy", "true")
  expect(screen.queryByRole("status")).toBeNull()
  expect(screen.queryByRole("progressbar")).toBeNull()
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()
  task.resolve()
  await waitFor(() => expect(screen.getByRole("region", { name: "Checkpoints for dev" })).not.toHaveAttribute("aria-busy"))
  expect(screen.getByRole("textbox", { name: "Checkpoint name" })).toHaveValue("")
})

it("keeps the panel busy without duplicating restore progress while restore is pending", async () => {
  const task = deferred()
  const restoreCheckpoint = vi.fn(() => task.promise)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ restoreCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }))
  expect(screen.getByRole("region", { name: "Checkpoints for dev" })).toHaveAttribute("aria-busy", "true")
  expect(screen.queryByRole("status")).toBeNull()
  expect(screen.queryByRole("progressbar")).toBeNull()
  expect(screen.getByRole("button", { name: "Confirm restore" })).toBeDisabled()
  task.resolve()
  await waitFor(() => expect(screen.getByRole("region", { name: "Checkpoints for dev" })).not.toHaveAttribute("aria-busy"))
})

it("shows action errors after an operation fails", async () => {
  const createCheckpoint = vi.fn().mockRejectedValue(new Error("Disk is full"))
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ createCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Checkpoint name" }), { target: { value: "before deploy" } })
  fireEvent.click(screen.getByRole("button", { name: "Create" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk is full")
})

it("allows create, restoring a different checkpoint, and saved checkpoint forks while restore is pending", async () => {
  const createCheckpoint = vi.fn().mockResolvedValue(undefined)
  const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  const pendingWorkspace = {
    ...workspace,
    checkpoints: [...workspace.checkpoints!, { id: "point-2", name: "After deploy", createdAt: "2026-09-26T10:00:00Z", scope: "disk", reason: "manual" }],
    pendingCheckpointRestore: { checkpointId: "point-1", sourceWorkspace: "dev", state: "full" },
  } as ApplicationWorkspace
  const actions = { createCheckpoint, restoreCheckpoint, forkCheckpoint } as unknown as ApplicationActions
  render(<CheckpointPanel workspace={pendingWorkspace} target="dev" actions={actions} disabled={false} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Checkpoint name" }), { target: { value: "After restore" } })
  fireEvent.click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(createCheckpoint).toHaveBeenCalledWith("dev", "After restore"))

  const differentCheckpoint = screen.getByText("After deploy").closest("li")!
  fireEvent.click(within(differentCheckpoint).getByRole("button", { name: "Restore" }))
  expect(within(differentCheckpoint).getByRole("button", { name: "Confirm restore" })).toBeVisible()
  fireEvent.click(within(differentCheckpoint).getByRole("button", { name: "Confirm restore" }))
  await waitFor(() => expect(restoreCheckpoint).toHaveBeenCalledWith("dev", "point-2"))

  const savedCheckpoint = screen.getByText("Before refactor").closest("li")!
  fireEvent.click(within(savedCheckpoint).getByRole("button", { name: "Fork" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Fork name" }), { target: { value: "saved-fork" } })
  fireEvent.click(screen.getByRole("button", { name: "Create fork" }))
  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledWith("dev", "point-1", "saved-fork"))
})
