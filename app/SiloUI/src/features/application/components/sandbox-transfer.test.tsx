import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { useSandboxTransfer } from "./sandbox-transfer"
import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupController, BackupOperation } from "../model/backup-source"

const source = applicationSourceForScenario("running")
const localVm = source.workspaces.find((w) => !w.computer && w.machine.kind === "vm")!
const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }

function controller(overrides: Partial<BackupController["state"]> = {}, actions: Partial<BackupController["actions"]> = {}): BackupController {
  return {
    state: { snapshotId: "1", availability: "available", archives: [archive], operation: null, ...overrides },
    actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn(), revealArchive: vi.fn().mockResolvedValue(undefined), ...actions },
  }
}

function Harness({ backup, openSandbox = vi.fn() }: { backup: BackupController; openSandbox?: (id: string) => void }) {
  const transfer = useSandboxTransfer(backup, { source, openSandbox })
  return <SettingsProvider initialSettings={{ theme: "light" }}>
    <Toaster />
    <button type="button" onClick={() => void transfer.exportSandbox("dev")}>Start export</button>
    <button type="button" onClick={() => void transfer.beginImport()}>Start import</button>
    {transfer.dialogs}
  </SettingsProvider>
}

afterEach(() => { toast.dismiss() })

describe("export notifications", () => {
  it("starts the export after a folder is chosen and shows a running toast, not an inline panel", async () => {
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue("/Volumes/Backups") })
    const { rerender } = render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start export" }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.startBackup).toHaveBeenCalledExactlyOnceWith("/Volumes/Backups", ["dev"], undefined)
    // No inline export panel is rendered anymore.
    expect(screen.queryByRole("region", { name: /Export dev/i })).not.toBeInTheDocument()

    const running: BackupOperation = { kind: "running", operation: "backup", archive, runningNames: [], progress: 40, phases: [{ title: "Save disk copies", detail: "Saving each managed disk.", tone: "running" }] }
    rerender(<Harness backup={controller({ operation: running })} />)
    expect(await screen.findByText("Exporting dev")).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Export progress" })).toBeInTheDocument()
  })

  it("does nothing when the folder picker is cancelled", async () => {
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue(null) })
    render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start export" }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.startBackup).not.toHaveBeenCalled()
  })

  it("keeps a success toast with Show in Finder that reveals the archive", async () => {
    const success: BackupOperation = { kind: "result", operation: "backup", archive, runningNames: [], outcome: "success", title: "Export ready", message: "done" }
    const backup = controller({ operation: success })
    render(<Harness backup={backup} />)
    expect(await screen.findByText("Exported")).toBeInTheDocument()
    expect(screen.getByText("dev.silo-backup · 2 GB")).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: /Show in (Finder|folder)/ }))
    expect(backup.actions.revealArchive).toHaveBeenCalledWith(archive)
  })

  it("dismissing a result toast clears the backend operation", async () => {
    const success: BackupOperation = { kind: "result", operation: "backup", archive, runningNames: [], outcome: "success", title: "Export ready", message: "done" }
    const backup = controller({ operation: success })
    render(<Harness backup={backup} />)
    fireEvent.click(await screen.findByRole("button", { name: /close|dismiss/i }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.dismissOperation).toHaveBeenCalled()
  })

  it("offers Retry on a failed export", async () => {
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue("/vol") })
    const { rerender } = render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start export" }))
    await act(async () => { await Promise.resolve() })
    const failed: BackupOperation = { kind: "result", operation: "backup", archive, runningNames: [], outcome: "failed", title: "Export could not be verified", message: "The destination disconnected." }
    rerender(<Harness backup={controller({ operation: failed }, { chooseDestination: backup.actions.chooseDestination, startBackup: backup.actions.startBackup })} />)
    expect(await screen.findByText("Export could not be verified")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.chooseDestination).toHaveBeenCalledTimes(2)
  })
})

describe("import notifications and dialog", () => {
  it("validates the new name, blocks conflicts, offers a source select, and imports", async () => {
    const multi = { ...archive, sandboxes: ["dev", "api"] }
    const backup = controller({}, { chooseArchive: vi.fn().mockImplementation(async (onSelected?: (path: string) => void) => { onSelected?.("/p"); return { archive: multi, valid: true } }) })
    render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start import" }))
    await act(async () => { await Promise.resolve() })
    const name = await screen.findByRole("textbox", { name: "New sandbox name" })
    expect(name).toHaveValue("dev-imported")
    expect(screen.getByRole("combobox", { name: "Sandbox to import" })).toBeInTheDocument()
    fireEvent.change(name, { target: { value: "Dev" } })
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
    fireEvent.change(name, { target: { value: "dev" } })
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
    fireEvent.change(name, { target: { value: "dev-copy" } })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    expect(backup.actions.startRestore).toHaveBeenCalledExactlyOnceWith(multi, "dev-copy", "dev")
  })

  it("reports an invalid export file in the dialog and lets the user choose another", async () => {
    const backup = controller({}, { chooseArchive: vi.fn().mockImplementation(async (onSelected?: (path: string) => void) => { onSelected?.("/p"); return { archive, valid: false, reason: "The checksum does not match." } }) })
    render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start import" }))
    await act(async () => { await Promise.resolve() })
    expect(await screen.findByText(/This export cannot be imported/)).toBeInTheDocument()
    expect(screen.getByText(/The checksum does not match/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose another file" })).toBeEnabled()
    expect(backup.actions.startRestore).not.toHaveBeenCalled()
  })

  it("shows an Open action on import success that navigates to the new sandbox", async () => {
    const openSandbox = vi.fn()
    const success: BackupOperation = { kind: "result", operation: "restore", archive, runningNames: [], targetName: localVm.machine.name, outcome: "success", title: `${localVm.machine.name} is ready`, message: "ok" }
    render(<Harness backup={controller({ operation: success })} openSandbox={openSandbox} />)
    expect(await screen.findByText(`Imported ${localVm.machine.name}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(openSandbox).toHaveBeenCalledWith(localVm.machine.id)
  })

  it("confirms before cancelling a running import", async () => {
    const running: BackupOperation = { kind: "running", operation: "restore", archive, runningNames: [], targetName: "dev-copy", progress: 30, phases: [{ title: "Create new sandbox", detail: "Writing managed disk data.", tone: "running" }] }
    const backup = controller({ operation: running })
    render(<Harness backup={backup} />)
    expect(await screen.findByText("Importing dev-copy")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(await screen.findByText("Cancel and remove dev-copy?")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel and remove" }))
    expect(backup.actions.cancelOperation).toHaveBeenCalledOnce()
  })
})
