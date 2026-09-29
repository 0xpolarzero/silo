import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ExportPanel, ImportPanel } from "./sandbox-transfer"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupController, BackupOperation } from "../model/backup-source"

const source = applicationSourceForScenario("running")
const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }

function controller(overrides: Partial<BackupController["state"]> = {}, actions: Partial<BackupController["actions"]> = {}): BackupController {
  return {
    state: { snapshotId: "1", availability: "available", archives: [archive], operation: null, ...overrides },
    actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn(), ...actions },
  }
}

describe("ExportPanel", () => {
  it("starts an export after a folder is chosen and never warns about stopping the sandbox", async () => {
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue("/Volumes/Backups") })
    render(<ExportPanel backup={backup} sandboxName="dev" autoStart onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.chooseDestination).toHaveBeenCalledOnce()
    expect(backup.actions.startBackup).toHaveBeenCalledExactlyOnceWith("/Volumes/Backups", ["dev"], undefined)
    expect(screen.queryByText(/must stop/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/start fresh/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Stop and back up/i })).not.toBeInTheDocument()
  })

  it("closes without starting when the folder picker is cancelled", async () => {
    const onClose = vi.fn()
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue(null) })
    render(<ExportPanel backup={backup} sandboxName="dev" autoStart onClose={onClose} />)
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.startBackup).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("shows progress and confirms before cancelling a running export", () => {
    const operation: BackupOperation = { kind: "running", operation: "backup", archive, runningNames: [], progress: 40, phases: [{ title: "Write and verify archive", detail: "Writing…", tone: "running" }] }
    const backup = controller({ operation })
    render(<ExportPanel backup={backup} sandboxName="dev" autoStart={false} onClose={vi.fn()} />)
    expect(screen.getByRole("progressbar", { name: "Export progress" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Cancel export…" }))
    expect(screen.getByText("Cancel this export?")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Cancel and clean up" }))
    expect(backup.actions.cancelOperation).toHaveBeenCalledOnce()
  })

  it("keeps a successful export result until the user dismisses it", async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const operation: BackupOperation = { kind: "result", operation: "backup", archive, runningNames: [], outcome: "success", title: "Export ready", message: "done" }
    const backup = controller({ operation })
    render(<ExportPanel backup={backup} sandboxName="dev" autoStart={false} onClose={onClose} />)
    expect(screen.getByRole("status")).toHaveTextContent("Export completed successfully.")
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(backup.actions.dismissOperation).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    vi.useRealTimers()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss success" }))
    expect(backup.actions.dismissOperation).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("exports a checkpoint's disks with its id after a folder is chosen", async () => {
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue("/Volumes/Backups") })
    render(<ExportPanel backup={backup} sandboxName="dev" checkpoint={{ id: "point-1", name: "Before refactor" }} autoStart onClose={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Export checkpoint “Before refactor”" })).toBeVisible()
    expect(screen.getByText(/Import restores its disks only/i)).toBeInTheDocument()
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.startBackup).toHaveBeenCalledExactlyOnceWith("/Volumes/Backups", ["dev"], "point-1")
  })
})

describe("ImportPanel", () => {
  it("validates the new name, blocks conflicts, and imports the selected sandbox", async () => {
    const backup = controller({}, { chooseArchive: vi.fn().mockResolvedValue({ archive, valid: true }) })
    render(<ImportPanel source={source} backup={backup} onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    const name = screen.getByRole("textbox", { name: "New sandbox name" })
    expect(name).toHaveValue("dev-imported")
    fireEvent.change(name, { target: { value: "Dev" } })
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
    fireEvent.change(name, { target: { value: "dev" } })
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
    fireEvent.change(name, { target: { value: "dev-copy" } })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    expect(backup.actions.startRestore).toHaveBeenCalledExactlyOnceWith(archive, "dev-copy", "dev")
  })

  it("reports an invalid export file and lets the user choose another", async () => {
    const backup = controller({}, { chooseArchive: vi.fn().mockResolvedValue({ archive, valid: false, reason: "The checksum does not match." }) })
    render(<ImportPanel source={source} backup={backup} onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be imported")
    expect(screen.getByRole("button", { name: "Choose another file" })).toBeEnabled()
    expect(backup.actions.startRestore).not.toHaveBeenCalled()
  })

  it("closes when no file is chosen", async () => {
    const onClose = vi.fn()
    const backup = controller({}, { chooseArchive: vi.fn().mockResolvedValue(null) })
    render(<ImportPanel source={source} backup={backup} onClose={onClose} />)
    await act(async () => { await Promise.resolve() })
    expect(onClose).toHaveBeenCalledOnce()
    expect(backup.actions.startRestore).not.toHaveBeenCalled()
  })

  it("shows running import progress and dismisses a failed result", () => {
    const running: BackupOperation = { kind: "running", operation: "restore", archive, runningNames: [], targetName: "dev-copy", progress: 30, phases: [{ title: "Create new sandbox", detail: "…", tone: "running" }] }
    const onClose = vi.fn()
    const backup = controller({ operation: running })
    const view = render(<ImportPanel source={source} backup={backup} onClose={onClose} />)
    expect(screen.getByRole("progressbar", { name: "Import progress" })).toBeVisible()
    const failed: BackupOperation = { kind: "result", operation: "restore", archive, runningNames: [], targetName: "dev-copy", outcome: "failed", title: "Import did not complete", message: "Verification failed." }
    view.rerender(<ImportPanel source={source} backup={controller({ operation: failed })} onClose={onClose} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Import did not complete")
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(onClose).toHaveBeenCalled()
  })
})
