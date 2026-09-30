import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import type { WorkspaceStorageState } from "../model/workspace-storage"
import type { BackupController, VerifiedExport } from "../model/backup-source"
import { OverviewPage } from "./overview-page"

const GiB = 1024 ** 3
const backup = { state: { availability: "available", operation: null }, actions: {} } as BackupController
const verified: VerifiedExport = { operationId: "export-dev", archive: { name: "dev", archivePath: "/fixture/dev.silo", completedLabel: "Now", size: "4.2 GB", destination: "/fixture", sandboxes: ["dev"] } }

for (const entry of ["row", "page"] as const) {
  it(`waits for a verified export before deleting from the ${entry}`, async () => {
    const user = userEvent.setup()
    const onMachinesChange = vi.fn()
    let complete!: (value: VerifiedExport | null) => void
    const onExportSandbox = vi.fn(() => new Promise<VerifiedExport | null>(resolve => { complete = resolve }))
    render(<OverviewPage source={stoppedDev()} actions={{} as ApplicationActions} backup={backup} onExportSandbox={onExportSandbox} onMachinesChange={onMachinesChange} />)
    if (entry === "page") await user.click(screen.getByRole("button", { name: "Open dev" }))
    await user.click(screen.getByRole("button", { name: "More actions for dev" }))
    await user.click(screen.getByRole("menuitem", { name: "Delete dev" }))
    await user.click(popover().getByRole("button", { name: "Export, then delete" }))
    expect(onExportSandbox).toHaveBeenCalledWith("dev")
    expect(onMachinesChange).not.toHaveBeenCalled()
    complete(verified)
    await waitFor(() => expect(onMachinesChange).toHaveBeenCalledTimes(1))
  })
}

it.each(["cancelled", "failed"])("keeps the sandbox when export is %s", async outcome => {
  const user = userEvent.setup()
  const onMachinesChange = vi.fn()
  const onExportSandbox = vi.fn(async () => { if (outcome === "failed") throw new Error("Export failed"); return null })
  render(<OverviewPage source={stoppedDev()} actions={{} as ApplicationActions} backup={backup} onExportSandbox={onExportSandbox} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete dev" }))
  await user.click(popover().getByRole("button", { name: "Export, then delete" }))
  await waitFor(() => expect(onExportSandbox).toHaveBeenCalled())
  expect(onMachinesChange).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Open dev" })).toBeVisible()
})

it("keeps a sandbox that started while its export was running", async () => {
  const user = userEvent.setup()
  const onMachinesChange = vi.fn()
  let complete!: (value: VerifiedExport) => void
  const onExportSandbox = vi.fn(() => new Promise<VerifiedExport>(resolve => { complete = resolve }))
  const source = stoppedDev()
  const view = (current: ApplicationSource) => <><Toaster /><OverviewPage source={current} actions={{} as ApplicationActions} backup={backup} onExportSandbox={onExportSandbox} onMachinesChange={onMachinesChange} /></>
  const { rerender } = render(view(source))
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete dev" }))
  await user.click(popover().getByRole("button", { name: "Export, then delete" }))
  const running = structuredClone(source)
  running.workspaces.find(({ machine }) => machine.name === "dev")!.state = "running"
  rerender(view(running))
  complete(verified)
  await waitFor(() => expect(screen.getByText("Couldn't delete dev")).toBeVisible())
  expect(onMachinesChange).not.toHaveBeenCalled()
})

function storage(bytes: number): WorkspaceStorageState {
  return { history: [], workspaceHostBytes: bytes - GiB / 2, runtimeHostBytes: GiB / 2, checkpointHostBytes: null, checkpointCount: 2, workspaceUsedBytes: null, workspaceCapacityBytes: null, lastReclaimedBytes: null, lastTrimAt: null, lastError: null }
}

function stoppedDev(): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  source.sandboxConfigurationOperation = null
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  dev.state = "stopped"
  dev.checkpoints = [
    { id: "c1", name: "One", createdAt: "2026-09-25T10:00:00.000Z", scope: "full", reason: "manual" },
    { id: "c2", name: "Two", createdAt: "2026-09-26T10:00:00.000Z", scope: "full", reason: "manual" },
  ]
  return source
}

function popover() {
  return within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!)
}

async function expectDeleteDialog() {
  const dialog = popover()
  expect(await dialog.findByText("Delete dev permanently?")).toBeVisible()
  expect(await dialog.findByText("Its files (4.2 GB) and 2 checkpoints will be deleted. This can't be undone.")).toBeVisible()
  const remove = dialog.getByRole("button", { name: "Delete permanently" })
  expect(remove.className).toContain("destructive")
  expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
  return remove
}

it("shows one permanent-deletion dialog, with the sandbox's size and checkpoints, from the list row", async () => {
  const user = userEvent.setup()
  const onMachinesChange = vi.fn()
  const readWorkspaceStorage = vi.fn(async () => storage(4.2 * GiB))
  render(<OverviewPage source={stoppedDev()} actions={{ readWorkspaceStorage } as unknown as ApplicationActions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete dev" }))
  const remove = await expectDeleteDialog()
  expect(readWorkspaceStorage).toHaveBeenCalledWith(stoppedDev().workspaces.find(({ machine }) => machine.name === "dev")!.machine.id)
  await user.click(remove)
  await waitFor(() => expect(onMachinesChange).toHaveBeenCalled())
})

it("shows the same dialog from the sandbox page", async () => {
  const user = userEvent.setup()
  const onMachinesChange = vi.fn()
  const readWorkspaceStorage = vi.fn(async () => storage(4.2 * GiB))
  render(<OverviewPage source={stoppedDev()} actions={{ readWorkspaceStorage } as unknown as ApplicationActions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: "Open dev" }))
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete dev" }))
  await user.click(await expectDeleteDialog())
  await waitFor(() => expect(onMachinesChange).toHaveBeenCalled())
  expect(await screen.findByRole("list", { name: "Configured sandboxes" })).toBeVisible()
})

it("omits the size while it is unknown and never blocks deletion on it", async () => {
  const user = userEvent.setup()
  const onMachinesChange = vi.fn()
  render(<OverviewPage source={stoppedDev()} actions={{ readWorkspaceStorage: vi.fn(async () => { throw new Error("offline") }) } as unknown as ApplicationActions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete dev" }))
  expect(await popover().findByText("Its files and 2 checkpoints will be deleted. This can't be undone.")).toBeVisible()
  await user.click(popover().getByRole("button", { name: "Delete permanently" }))
  await waitFor(() => expect(onMachinesChange).toHaveBeenCalled())
})
