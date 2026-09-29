import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import type { ApplicationActions, ApplicationWorkspace } from "@/features/application/model/application-source"
import { CheckpointPanel } from "./checkpoint-panel"

const workspace = {
  machine: { id: "vm-dev", name: "dev", kind: "vm" },
  checkpoints: [
    { id: "point-1", name: "Before refactor", createdAt: "2026-09-25T10:00:00Z", scope: "full", reason: "manual" },
    { id: "point-2", name: "Disk snapshot", createdAt: "2026-09-24T10:00:00Z", scope: "disk", reason: "manual" },
    { id: "point-3", name: "Before restore", createdAt: "2026-09-23T10:00:00Z", scope: "full", reason: "before-restore" },
  ],
} as ApplicationWorkspace

afterEach(() => { toast.dismiss() })
function withToaster(node: React.ReactNode) { return <SettingsProvider initialSettings={{ theme: "light" }}><Toaster />{node}</SettingsProvider> }

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function confirmButton(name: string) { return within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name }) }

it("shows a Restore button and a menu with Fork and Export on a local checkpoint", async () => {
  const onExport = vi.fn()
  const user = userEvent.setup()
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint: vi.fn(), restoreCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} onExport={onExport} />)
  const row = within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!)
  expect(row.getByRole("button", { name: "Restore" })).toBeVisible()
  await user.click(row.getByRole("button", { name: "Checkpoint actions for Before refactor" }))
  expect(screen.getByRole("menuitem", { name: "Fork Before refactor" })).toBeVisible()
  await user.click(screen.getByRole("menuitem", { name: "Export Before refactor" }))
  expect(onExport).toHaveBeenCalledWith(workspace.checkpoints![0])
})

it("labels checkpoint scope and recovery with a short tag", () => {
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{} as ApplicationActions} disabled={false} />)
  expect(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByText(/Includes memory/)).toBeVisible()
  expect(within(screen.getByText("Disk snapshot").closest("[data-checkpoint-name]")!).getByText(/Disks only/)).toBeVisible()
  expect(within(screen.getByText("Before restore").closest("[data-checkpoint-name]")!).getByText(/Recovery/)).toBeVisible()
})

it("hides Export for a remote sandbox checkpoint", async () => {
  const remote = { ...workspace, computer: { id: "mac", name: "Ada’s Mac mini", connected: true } } as ApplicationWorkspace
  const user = userEvent.setup()
  render(<CheckpointPanel workspace={remote} target="dev" actions={{ forkCheckpoint: vi.fn(), restoreCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} onExport={vi.fn()} />)
  await user.click(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Checkpoint actions for Before refactor" }))
  expect(screen.queryByRole("menuitem", { name: "Export Before refactor" })).toBeNull()
  expect(screen.getByRole("menuitem", { name: "Fork Before refactor" })).toBeVisible()
})

it("disables Export while a transfer is running", async () => {
  const user = userEvent.setup()
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint: vi.fn(), restoreCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} onExport={vi.fn()} exportDisabled />)
  await user.click(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Checkpoint actions for Before refactor" }))
  expect(screen.getByRole("menuitem", { name: "Export Before refactor" })).toHaveAttribute("aria-disabled", "true")
})

it("confirms a restore in a popover before restoring", async () => {
  const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ restoreCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  await user.click(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Restore" }))
  expect(await screen.findByText("Restore “Before refactor”?")).toBeVisible()
  expect(screen.getByText(/saves a recovery checkpoint first/i)).toBeVisible()
  expect(restoreCheckpoint).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByText("Restore “Before refactor”?")).toBeNull()
  await user.click(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Restore" }))
  await user.click(confirmButton("Restore"))
  await waitFor(() => expect(restoreCheckpoint).toHaveBeenCalledWith("dev", "point-1"))
})

it("names a stopped fork from the selected checkpoint", async () => {
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  await user.click(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Checkpoint actions for Before refactor" }))
  await user.click(screen.getByRole("menuitem", { name: "Fork Before refactor" }))
  expect(await screen.findByText("Fork from “Before refactor”")).toBeVisible()
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "experiment")
  await user.click(screen.getByRole("button", { name: "Fork" }))
  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledWith("dev", "point-1", "experiment"))
})

it("creates a checkpoint from a prefilled name in a popover", async () => {
  const createCheckpoint = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ createCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  await user.click(screen.getByRole("button", { name: "New checkpoint" }))
  const input = screen.getByRole("textbox", { name: "Checkpoint name" })
  expect((input as HTMLInputElement).value).toMatch(/^Checkpoint /)
  await user.clear(input)
  await user.type(input, "before deploy")
  await user.click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(createCheckpoint).toHaveBeenCalledWith("dev", "before deploy"))
})

it("shows a calm empty state with the New checkpoint button", () => {
  const empty = { ...workspace, checkpoints: [] } as ApplicationWorkspace
  render(<CheckpointPanel workspace={empty} target="dev" actions={{ createCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} />)
  expect(screen.getByText("No checkpoints yet")).toBeVisible()
  expect(screen.getByRole("button", { name: "New checkpoint" })).toBeVisible()
})

it("notes a failed operation from before this session inline without a notification", () => {
  const failed = { ...workspace, checkpointOperation: { kind: "capture", status: "failed", stage: "Capture failed", error: "Disk is full" } } as ApplicationWorkspace
  render(withToaster(<CheckpointPanel workspace={failed} target="dev" actions={{ createCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} />))
  expect(screen.getByText("Disk is full")).toBeVisible()
  expect(document.querySelector("[data-sonner-toast]")).toBeNull()
})

it("notifies about a failed create with Retry instead of inserting an error", async () => {
  const createCheckpoint = vi.fn().mockRejectedValueOnce(new Error("Disk is full")).mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(withToaster(<CheckpointPanel workspace={workspace} target="dev" actions={{ createCheckpoint } as unknown as ApplicationActions} disabled={false} />))
  await user.click(screen.getByRole("button", { name: "New checkpoint" }))
  await user.clear(screen.getByRole("textbox", { name: "Checkpoint name" }))
  await user.type(screen.getByRole("textbox", { name: "Checkpoint name" }), "before deploy")
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(await screen.findByText("Disk is full")).toBeInTheDocument()
  expect(screen.getByText("Could not create checkpoint “before deploy”")).toBeInTheDocument()
  expect(screen.queryByRole("alert")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText("Checkpoint created")).toBeInTheDocument()
  expect(createCheckpoint).toHaveBeenCalledTimes(2)
})

it("shows a loading notification while a create is pending and marks the region busy", async () => {
  const task = deferred()
  const createCheckpoint = vi.fn(() => task.promise)
  const user = userEvent.setup()
  render(withToaster(<CheckpointPanel workspace={workspace} target="dev" actions={{ createCheckpoint } as unknown as ApplicationActions} disabled={false} />))
  await user.click(screen.getByRole("button", { name: "New checkpoint" }))
  await user.clear(screen.getByRole("textbox", { name: "Checkpoint name" }))
  await user.type(screen.getByRole("textbox", { name: "Checkpoint name" }), "before deploy")
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(await screen.findByText("Creating checkpoint “before deploy”")).toBeInTheDocument()
  expect(screen.getByRole("region", { name: "Checkpoints for dev" })).toHaveAttribute("aria-busy", "true")
  expect(screen.getByRole("button", { name: "New checkpoint" })).toBeDisabled()
  task.resolve()
  expect(await screen.findByText("Checkpoint created")).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole("region", { name: "Checkpoints for dev" })).not.toHaveAttribute("aria-busy"))
})

it("reports a restore as one progress notification that turns into the result, with no dialog", async () => {
  const task = deferred()
  const restoreCheckpoint = vi.fn(() => task.promise)
  const user = userEvent.setup()
  render(withToaster(<CheckpointPanel workspace={workspace} target="dev" actions={{ restoreCheckpoint } as unknown as ApplicationActions} disabled={false} restoredAction={() => ({ label: "Start", onClick: vi.fn() })} />))
  await user.click(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Restore" }))
  await user.click(within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name: "Restore" }))
  expect(await screen.findByText("Restoring “Before refactor”")).toBeVisible()
  expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent("Save recovery checkpoint")
  expect(screen.queryByRole("dialog")).toBeNull()
  task.resolve()
  expect(await screen.findByText("Restored “Before refactor”")).toBeVisible()
  expect(screen.queryByText("Restoring “Before refactor”")).toBeNull()
  expect(screen.getByRole("button", { name: "Start" })).toBeVisible()
})

it("keeps a failed restore in its notification with Retry", async () => {
  const restoreCheckpoint = vi.fn().mockRejectedValueOnce(new Error("Disk is busy")).mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(withToaster(<CheckpointPanel workspace={workspace} target="dev" actions={{ restoreCheckpoint } as unknown as ApplicationActions} disabled={false} />))
  await user.click(within(screen.getByText("Before refactor").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Restore" }))
  await user.click(within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name: "Restore" }))
  expect(await screen.findByText("Disk is busy")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText("Restored “Before refactor”")).toBeInTheDocument()
  expect(restoreCheckpoint).toHaveBeenCalledTimes(2)
})

it("suggests an English checkpoint name regardless of the system locale", async () => {
  const original = Date.prototype.toLocaleString
  const seen: unknown[] = []
  Date.prototype.toLocaleString = function (locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) { seen.push(locale); return original.call(this, locale ?? "fr", options) }
  try {
    const user = userEvent.setup()
    render(<CheckpointPanel workspace={workspace} target="dev" actions={{ createCheckpoint: vi.fn() } as unknown as ApplicationActions} disabled={false} />)
    await user.click(screen.getByRole("button", { name: "New checkpoint" }))
    const value = (screen.getByRole("textbox", { name: "Checkpoint name" }) as HTMLInputElement).value
    expect(value).toMatch(/^Checkpoint [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/)
    expect(seen).toContain("en")
  } finally { Date.prototype.toLocaleString = original }
})
