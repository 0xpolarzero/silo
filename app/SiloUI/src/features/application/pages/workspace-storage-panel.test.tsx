import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { WorkspaceStoragePanel } from "./workspace-storage-panel"
import { OverviewPage } from "./overview-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import type { WorkspaceStorageState } from "../model/workspace-storage"

const gib = 1024 ** 3
const storage: WorkspaceStorageState = { history: [], workspaceHostBytes: 36 * gib, runtimeHostBytes: 5 * gib, workspaceUsedBytes: gib, workspaceCapacityBytes: 64 * gib, lastReclaimedBytes: null, lastTrimAt: null, lastError: null }

it("distinguishes host allocation from guest usage and reports measured recovery", async () => {
  const read = vi.fn().mockResolvedValue(storage)
  let finish!: (value: WorkspaceStorageState) => void
  const reclaim = vi.fn().mockImplementation(() => new Promise<WorkspaceStorageState>(resolve => { finish = resolve }))
  const user = userEvent.setup()
  render(<WorkspaceStoragePanel workspaceId="vm-id" running read={read} reclaim={reclaim} />)
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  expect(screen.getByText("1.00 GiB")).toBeVisible()
  expect(screen.getByText("5.00 GiB")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Reclaim unused space" }))
  expect(reclaim).toHaveBeenCalledExactlyOnceWith("vm-id")
  expect(screen.getByRole("button", { name: "Reclaim unused space" })).toBeDisabled()
  expect(screen.getByRole("progressbar", { name: "Reclaim progress" })).not.toHaveAttribute("aria-valuenow")
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeDisabled()
  await act(async () => finish({ ...storage, workspaceHostBytes: 2 * gib, lastReclaimedBytes: 34 * gib, lastTrimAt: 1000 }))
  expect(screen.getByRole("status")).toHaveTextContent("Reclaimed 34.00 GiB on this computer.")
  expect(screen.getByText("2.00 GiB")).toBeVisible()
})

it("requires a running sandbox without starting it and hides stale guest usage", async () => {
  const read = vi.fn().mockResolvedValue(storage)
  const reclaim = vi.fn()
  render(<WorkspaceStoragePanel workspaceId="vm-id" running={false} read={read} reclaim={reclaim} />)
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
  render(<WorkspaceStoragePanel workspaceId="vm-id" running read={read} reclaim={reclaim} />)
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable")
  await user.click(screen.getByRole("button", { name: "Refresh storage" }))
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Reclaim unused space" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace trim failed")
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
  render(<WorkspaceStoragePanel workspaceId="first" running read={read} reclaim={vi.fn()} />)
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
  const view = render(<WorkspaceStoragePanel workspaceId="first" running read={read} reclaim={reclaim} />)
  expect(await screen.findByText("36.00 GiB")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Refresh storage" }))
  view.rerender(<WorkspaceStoragePanel workspaceId="second" running read={read} reclaim={reclaim} />)
  expect(screen.queryByText("36.00 GiB")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeDisabled()
  await act(async () => finishNew(storage))
  await user.click(screen.getByRole("button", { name: "Reclaim unused space" }))
  expect(await screen.findByText("2.00 GiB")).toBeVisible()
  await act(async () => finishOld(storage))
  expect(screen.getByText("2.00 GiB")).toBeVisible()
  expect(screen.getByRole("status")).toHaveTextContent("Reclaimed 34.00 GiB")
  expect(reclaim).toHaveBeenCalledExactlyOnceWith("second")
})

it("keeps real history collapsed, reveals results and refreshes failures from the backend", async () => {
  const history = Array.from({ length: 18 }, (_, i) => ({ at: 1000 + i, trigger: "scheduled", reclaimedBytes: i * gib, error: null }))
  const read = vi.fn().mockResolvedValueOnce({ ...storage, history }).mockResolvedValueOnce({ ...storage, history: [{ at: 2000, trigger: "manual", reclaimedBytes: null, error: "Reclaim timed out" }, ...history] })
  const user = userEvent.setup()
  render(<WorkspaceStoragePanel workspaceId="vm-id" running read={read} reclaim={vi.fn().mockRejectedValue(new Error("Reclaim timed out"))} />)
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
