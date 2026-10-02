import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { WorkspaceStoragePanel } from "./workspace-storage-panel"
import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { OverviewPage } from "./overview-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { workspaceStorageStateSchema, type WorkspaceStorageState } from "../model/workspace-storage"

afterEach(() => { toast.dismiss() })
function Panel(props: React.ComponentProps<typeof WorkspaceStoragePanel>) { return <SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><WorkspaceStoragePanel {...props} /></SettingsProvider> }

const gib = 1024 ** 3
const storage: WorkspaceStorageState = { history: [], workspaceHostBytes: 36 * gib, runtimeHostBytes: 5 * gib, checkpointHostBytes: 3 * gib, checkpointCount: 2, workspaceUsedBytes: gib, workspaceCapacityBytes: 64 * gib, lastReclaimedBytes: null, lastTrimAt: null, lastError: null }

it.each(["__proto__", "constructor", "toString", "future-trigger"])("shows unknown reclaim trigger %s as Automatic", async trigger => {
  const state = workspaceStorageStateSchema.parse({ ...storage, history: [{ at: 1000, trigger, reclaimedBytes: 0, error: null }] })
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue(state)} />)
  fireEvent.click(await screen.findByRole("button", { name: "Reclaim history, 1 attempt" }))
  expect(screen.getByText(/^Automatic ·/)).toBeVisible()
  expect(screen.getByText("No unused space to reclaim")).toBeVisible()
})

it.each([
  ["manual", "Manual"], ["scheduled", "Scheduled"], ["beforeStop", "Before stop"],
  ["afterStart", "After start"], ["legacy", "Previous reclaim"],
])("preserves the label for reclaim trigger %s", async (trigger, label) => {
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue({ ...storage, history: [{ at: 1000, trigger, reclaimedBytes: 0, error: null }] })} />)
  fireEvent.click(await screen.findByRole("button", { name: "Reclaim history, 1 attempt" }))
  expect(screen.getByText(new RegExp(`^${label} ·`))).toBeVisible()
})

it.each([[1, "attempt"], [2, "attempts"]])("pluralizes the reclaim history label for %i %s", async (count, noun) => {
  const history = Array.from({ length: count }, (_, i) => ({ at: 1000 + i, trigger: "manual", reclaimedBytes: 0, error: null }))
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue({ ...storage, history })} reclaim={vi.fn()} />)
  expect(await screen.findByRole("button", { name: `Reclaim history, ${count} ${noun}` })).toBeVisible()
})

it("distinguishes reclaim attempts from different years", async () => {
  const history = ["2026-10-01T12:00:00Z", "2025-10-01T12:00:00Z"].map(at => ({ at: Date.parse(at) / 1000, trigger: "manual", reclaimedBytes: 0, error: null }))
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue({ ...storage, history })} reclaim={vi.fn()} />)
  fireEvent.click(await screen.findByRole("button", { name: "Reclaim history, 2 attempts" }))
  const entries = screen.getByLabelText("Reclaim history entries")
  expect(entries).toHaveTextContent("2025")
  expect(entries).toHaveTextContent("2026")
})

it("distinguishes host allocation from guest usage and reports measured recovery", async () => {
  const read = vi.fn().mockResolvedValue(storage)
  let finish!: (value: WorkspaceStorageState) => void
  const reclaim = vi.fn().mockImplementation(() => new Promise<WorkspaceStorageState>(resolve => { finish = resolve }))
  const user = userEvent.setup()
  render(<Panel workspaceId="vm-id" running read={read} reclaim={reclaim} />)
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(screen.getByText("1.00 GiB")).toBeVisible()
  expect(screen.getByText("5.00 GiB")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Reclaim unused space" }))
  expect(reclaim).toHaveBeenCalledExactlyOnceWith("vm-id")
  expect(screen.getByRole("button", { name: "Reclaim unused space" })).toBeDisabled()
  expect(await screen.findByText("Reclaiming unused space")).toBeVisible()
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeDisabled()
  await act(async () => finish({ ...storage, workspaceHostBytes: 2 * gib, lastReclaimedBytes: 34 * gib, lastTrimAt: 1000 }))
  expect(await screen.findByText("Reclaimed 34.00 GiB")).toBeVisible()
  expect(screen.getByText("2.00 GiB")).toBeVisible()
})

it("names the owning computer instead of this computer for a remote sandbox", async () => {
  const read = vi.fn().mockResolvedValue(storage)
  const { unmount } = render(<Panel workspaceId="vm-id" running computerName="studio" read={read} />)
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(screen.getByText("studio")).toBeVisible()
  expect(screen.queryByText("This computer")).not.toBeInTheDocument()
  unmount()
  render(<Panel workspaceId="vm-id" running read={read} />)
  expect(await screen.findByText("This computer")).toBeVisible()
})

it("requires a running sandbox without starting it and hides stale guest usage", async () => {
  const read = vi.fn().mockResolvedValue(storage)
  const reclaim = vi.fn()
  render(<Panel workspaceId="vm-id" running={false} read={read} reclaim={reclaim} />)
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(screen.getAllByText("Unavailable")[0]).toBeVisible()
  expect(screen.queryByText("1.00 GiB")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Reclaim unused space" })).toBeDisabled()
  expect(reclaim).not.toHaveBeenCalled()
})

it("shows failures without claiming recovery and permits retry", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("Storage unavailable")).mockResolvedValue(storage)
  const reclaim = vi.fn().mockRejectedValue(new Error("Workspace trim failed"))
  const user = userEvent.setup()
  render(<Panel workspaceId="vm-id" running read={read} reclaim={reclaim} />)
  expect(await screen.findByText("Storage unavailable")).toBeVisible()
  expect(screen.queryByText(/No checkpoints are saved/)).not.toBeInTheDocument()
  expect(screen.queryByText("No reclaims yet")).not.toBeInTheDocument()
  expect(screen.getByText("Refresh storage to check saved checkpoints.")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(screen.getByText("No reclaims yet")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Reclaim unused space" }))
  expect(await screen.findByText("Workspace trim failed")).toBeVisible()
  expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0)
  expect(screen.queryByText(/Reclaimed/)).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Reclaim unused space" })).toBeEnabled()
})

it("opens storage from a local sandbox menu and sends its managed ID", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const read = vi.fn().mockResolvedValue(storage)
  const actions = { readWorkspaceStorage: read, reclaimWorkspaceStorage: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Storage for ${workspace.machine.name}` }))
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(read).toHaveBeenCalledExactlyOnceWith(workspace.machine.id)
})

it("does not offer storage reclamation on remote computers", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.computer = { id: "remote", vmId: workspace.machine.id, name: "Other computer", address: "other.test", connected: true }
  const read = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ readWorkspaceStorage: read } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  expect(screen.queryByRole("menuitem", { name: `Storage for ${workspace.machine.name}` })).not.toBeInTheDocument()
  expect(read).not.toHaveBeenCalled()
})

it("keeps controls disabled until initial storage resolves", async () => {
  let finish!: (value: WorkspaceStorageState) => void
  const read = vi.fn().mockImplementation(() => new Promise<WorkspaceStorageState>(resolve => { finish = resolve }))
  render(<Panel workspaceId="first" running read={read} reclaim={vi.fn()} />)
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Reclaim unused space" })).toBeDisabled()
  await act(async () => finish(storage))
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeEnabled()
})

it("resets changed workspaces and ignores a delayed old read after successful reclaim", async () => {
  let finishOld!: (value: WorkspaceStorageState) => void
  let finishNew!: (value: WorkspaceStorageState) => void
  const read = vi.fn().mockResolvedValueOnce(storage)
    .mockImplementationOnce(() => new Promise<WorkspaceStorageState>(resolve => { finishOld = resolve }))
    .mockImplementationOnce(() => new Promise<WorkspaceStorageState>(resolve => { finishNew = resolve }))
  const reclaim = vi.fn().mockResolvedValue({ ...storage, workspaceHostBytes: 2 * gib, lastReclaimedBytes: 34 * gib })
  const user = userEvent.setup()
  const view = render(<Panel workspaceId="first" running read={read} reclaim={reclaim} />)
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Refresh storage" }))
  view.rerender(<Panel workspaceId="second" running read={read} reclaim={reclaim} />)
  expect(screen.queryByText("36.00 GiB")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeDisabled()
  await act(async () => finishNew(storage))
  await user.click(screen.getByRole("button", { name: "Reclaim unused space" }))
  expect(await screen.findByText("2.00 GiB")).toBeVisible()
  await act(async () => finishOld(storage))
  expect(screen.getByText("2.00 GiB")).toBeVisible()
  expect(await screen.findByText("Reclaimed 34.00 GiB")).toBeVisible()
  expect(reclaim).toHaveBeenCalledExactlyOnceWith("second")
})

it("keeps real history collapsed, reveals results and refreshes failures from the backend", async () => {
  const history = Array.from({ length: 18 }, (_, i) => ({ at: 1000 + i, trigger: "scheduled", reclaimedBytes: i * gib, error: null }))
  const read = vi.fn().mockResolvedValueOnce({ ...storage, history }).mockResolvedValueOnce({ ...storage, history: [{ at: 2000, trigger: "manual", reclaimedBytes: null, error: "Reclaim timed out" }, ...history] })
  const user = userEvent.setup()
  render(<Panel workspaceId="vm-id" running read={read} reclaim={vi.fn().mockRejectedValue(new Error("Reclaim timed out"))} />)
  const toggle = await screen.findByRole("button", { name: /Reclaim history, 18/ })
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByText("17.00 GiB reclaimed")).not.toBeInTheDocument()
  await user.click(toggle)
  expect(screen.getByText("17.00 GiB reclaimed")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Reclaim unused space" }))
  expect(await screen.findByText("Reclaim did not complete")).toBeVisible()
  expect(read).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("button", { name: /Reclaim history, 19/ })).toHaveAttribute("aria-expanded", "true")
})

it("shows a disk Silo could not find as unknown instead of 0 B", async () => {
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue({ ...storage, workspaceHostBytes: null, runtimeHostBytes: null })} />)
  expect(await screen.findAllByText("Unknown")).toHaveLength(2)
  expect(screen.queryByText("0 B")).not.toBeInTheDocument()
})

it("shows how much space the sandbox's checkpoints use and where to delete them", async () => {
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue(storage)} />)
  expect(await screen.findByText("3.00 GiB")).toBeVisible()
  expect(screen.getByText("Checkpoints")).toBeVisible()
  expect(screen.getByText(/2 checkpoints saved on this computer/)).toBeVisible()
  expect(screen.getByText(/Delete ones you no longer need in Checkpoints/)).toBeVisible()
})

it("explains each measurement and the automatic reclaim policy in visible text", async () => {
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue(storage)} reclaim={vi.fn()} />)
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(screen.getByText(/Deleted files keep using this space until it is reclaimed/)).toBeVisible()
  expect(screen.getByText(/Reclaiming space does not shrink it/)).toBeVisible()
  expect(screen.getByText(/Used inside the sandbox/)).toBeVisible()
  expect(screen.getByText(/The most the workspace can hold/)).toBeVisible()
  expect(screen.getByText(/Silo reclaims automatically after 7 days of running/)).toBeVisible()
})

it("expands a failed reclaim's error inline from its Details button", async () => {
  const history = [
    { at: 2000, trigger: "manual", reclaimedBytes: null, error: "The runtime shortened the workspace disk; its original length was restored." },
    { at: 1000, trigger: "scheduled", reclaimedBytes: gib, error: null },
  ]
  const user = userEvent.setup()
  render(<Panel workspaceId="vm-id" running read={vi.fn().mockResolvedValue({ ...storage, history })} reclaim={vi.fn()} />)
  await user.click(await screen.findByRole("button", { name: /Reclaim history, 2/ }))
  const details = screen.getByRole("button", { name: "Details for reclaim 1" })
  expect(details).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByText(/its original length was restored/)).not.toBeInTheDocument()
  await user.click(details)
  expect(details).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText(/its original length was restored/)).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Details for reclaim 2" }))
  expect(screen.getByText(/Unused blocks were released; workspace files and capacity were preserved/)).toBeVisible()
  await user.click(details)
  expect(screen.queryByText(/its original length was restored/)).not.toBeInTheDocument()
})


it("uses current disabled state and prevents overlapping toast Retry reads", async () => {
  let finish!: (value: WorkspaceStorageState) => void
  const read = vi.fn().mockRejectedValueOnce(new Error("Initial storage read failed"))
    .mockImplementationOnce(() => new Promise<WorkspaceStorageState>(resolve => { finish = resolve }))
  const view = render(<Panel workspaceId="vm-id" running read={read} />)
  expect(await screen.findByText("Initial storage read failed")).toBeVisible()
  const retry = screen.getByRole("button", { name: "Retry" })
  view.rerender(<Panel workspaceId="vm-id" running disabled read={read} />)
  fireEvent.click(retry)
  expect(read).toHaveBeenCalledOnce()
  view.rerender(<Panel workspaceId="vm-id" running read={read} />)
  act(() => { fireEvent.click(retry); fireEvent.click(retry) })
  expect(read).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeDisabled()
  expect(screen.queryByText("36.00 GiB")).not.toBeInTheDocument()
  await act(async () => finish(storage))
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(read).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeEnabled()
})
