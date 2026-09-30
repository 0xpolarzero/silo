import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { useSandboxTransfer, type SandboxTransfer } from "./sandbox-transfer"
import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { ExportIncompleteError, type BackupController, type BackupOperation } from "../model/backup-source"

const source = applicationSourceForScenario("running")
const localVm = source.workspaces.find((w) => !w.computer && w.machine.kind === "vm")!
const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }

function controller(overrides: Partial<BackupController["state"]> = {}, actions: Partial<BackupController["actions"]> = {}): BackupController {
  return {
    state: { snapshotId: "1", availability: "available", archives: [archive], operation: null, ...overrides },
    actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), exportAndVerify: vi.fn().mockReturnValue(new Promise(() => {})), startRestore: vi.fn(), cancelOperation: vi.fn(), dismissOperation: vi.fn(), revealArchive: vi.fn().mockResolvedValue(undefined), ...actions },
  }
}

function Capture({ backup, onTransfer }: { backup: BackupController; onTransfer: (transfer: SandboxTransfer) => void }) {
  onTransfer(useSandboxTransfer(backup, { source }))
  return null
}

function Harness({ backup, openSandbox = vi.fn() }: { backup: BackupController; openSandbox?: (id: string) => void }) {
  const transfer = useSandboxTransfer(backup, { source, openSandbox })
  return <SettingsProvider initialSettings={{ theme: "light" }}>
    <Toaster />
    <button type="button" onClick={() => void transfer.exportSandbox("dev")}>Start export</button>
    <button type="button" onClick={() => void transfer.beginImport()}>Start import</button>
    {transfer.importPopover(<button type="button">Add</button>)}
  </SettingsProvider>
}

afterEach(() => { toast.dismiss() })

describe("export notifications", () => {
  it("starts the export after a folder is chosen and shows a running toast, not an inline panel", async () => {
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue("/Volumes/Backups") })
    const { rerender } = render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start export" }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.exportAndVerify).toHaveBeenCalledExactlyOnceWith("/Volumes/Backups", ["dev"], undefined)
    // No inline export panel is rendered anymore.
    expect(screen.queryByRole("region", { name: /Export dev/i })).not.toBeInTheDocument()

    const running: BackupOperation = { kind: "running", operation: "backup", archive, runningNames: [], progress: 40, phases: [{ title: "Save disk copies", detail: "Saving each managed disk.", tone: "running" }] }
    rerender(<Harness backup={controller({ operation: running })} />)
    expect(await screen.findByText("Exporting dev")).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Saving each managed disk." })).toBeInTheDocument()
  })

  it("resolves with the verified export, or null when no verified export was produced", async () => {
    const verified = { operationId: "op-1", archive }
    const exportAndVerify = vi.fn().mockResolvedValueOnce(verified).mockRejectedValueOnce(new ExportIncompleteError("failed", "Disk full", "op-2"))
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValueOnce("/Volumes/Backups").mockResolvedValueOnce("/Volumes/Backups").mockResolvedValueOnce(null), exportAndVerify })
    let transfer: SandboxTransfer | undefined
    render(<Capture backup={backup} onTransfer={(value) => { transfer = value }} />)
    await expect(transfer!.exportSandbox("dev", { id: "checkpoint-1", name: "Before upgrade" })).resolves.toEqual(verified)
    expect(exportAndVerify).toHaveBeenCalledWith("/Volumes/Backups", ["dev"], "checkpoint-1")
    await expect(transfer!.exportSandbox("dev")).resolves.toBeNull()
    await expect(transfer!.exportSandbox("dev")).resolves.toBeNull()
    expect(exportAndVerify).toHaveBeenCalledTimes(2)
  })

  it("titles a checkpoint export from the backend state, even after a reload", async () => {
    const checkpointArchive = { ...archive, checkpointName: "Before upgrade" }
    const running: BackupOperation = { kind: "running", operation: "backup", archive: checkpointArchive, runningNames: [], progress: 0, phases: [{ title: "Waiting for other sandbox work", detail: "", tone: "running" }] }
    const { rerender } = render(<Harness backup={controller({ operation: running })} />)
    expect(await screen.findByText("Exporting checkpoint “Before upgrade”")).toBeInTheDocument()
    const done: BackupOperation = { kind: "result", operation: "backup", archive: checkpointArchive, runningNames: [], outcome: "success", title: "Export complete", message: "Sandbox exported." }
    rerender(<Harness backup={controller({ operation: done })} />)
    expect(await screen.findByText("Checkpoint exported")).toBeInTheDocument()
  })

  it("starting another export while one runs changes neither its title nor its Retry", async () => {
    const running: BackupOperation = { kind: "running", operation: "backup", archive, runningNames: [], progress: 0, phases: [{ title: "Capture and verify", detail: "", tone: "running" }] }
    const chooseDestination = vi.fn().mockResolvedValue("/Volumes/Backups")
    const exportAndVerify = vi.fn()
    let transfer: SandboxTransfer | undefined
    const view = (operation: BackupOperation) => <SettingsProvider initialSettings={{ theme: "light" }}>
      <Toaster />
      <Capture backup={controller({ operation }, { chooseDestination, exportAndVerify })} onTransfer={(value) => { transfer = value }} />
    </SettingsProvider>
    const { rerender } = render(view(running))
    expect(await screen.findByText("Exporting dev")).toBeInTheDocument()
    await expect(transfer!.exportSandbox("dev", { id: "checkpoint-1", name: "Other" })).resolves.toBeNull()
    expect(exportAndVerify).not.toHaveBeenCalled()
    expect(screen.getByText("Exporting dev")).toBeInTheDocument()
    // The export this hook never started fails: there is nothing of its own to retry.
    rerender(view({ kind: "result", operation: "backup", archive, runningNames: [], outcome: "failed", title: "Export failed", message: "Disk full" }))
    expect(await screen.findByText("Export failed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })

  it("does nothing when the folder picker is cancelled", async () => {
    const backup = controller({}, { chooseDestination: vi.fn().mockResolvedValue(null) })
    render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start export" }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.exportAndVerify).not.toHaveBeenCalled()
  })

  it("keeps a success toast with Show in Finder that reveals the export file", async () => {
    const success: BackupOperation = { kind: "result", operation: "backup", archive, runningNames: [], outcome: "success", title: "Export ready", message: "done" }
    const backup = controller({ operation: success })
    const { rerender } = render(<Harness backup={controller()} />)
    rerender(<Harness backup={backup} />)
    expect(await screen.findByText("Exported")).toBeInTheDocument()
    expect(screen.getByText("dev.silo-backup · 2 GB")).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: /Show in (Finder|folder)/ }))
    expect(backup.actions.revealArchive).toHaveBeenCalledWith(archive)
  })

  it("dismissing a result toast clears the backend operation", async () => {
    const success: BackupOperation = { kind: "result", operation: "backup", archive, runningNames: [], outcome: "success", title: "Export ready", message: "done" }
    const backup = controller({ operation: success })
    const { rerender } = render(<Harness backup={controller()} />)
    rerender(<Harness backup={backup} />)
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
    rerender(<Harness backup={controller({ operation: failed }, { chooseDestination: backup.actions.chooseDestination, exportAndVerify: backup.actions.exportAndVerify })} />)
    expect(await screen.findByText("Export could not be verified")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.chooseDestination).toHaveBeenCalledTimes(2)
  })
})

describe("results present at load", () => {
  it("does not toast a finished result from a previous session", async () => {
    const success: BackupOperation = { kind: "result", operation: "restore", archive, runningNames: [], targetName: localVm.machine.name, outcome: "success", title: "ready", message: "ok" }
    const backup = controller({ operation: success })
    render(<Harness backup={backup} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(`Imported ${localVm.machine.name}`)).not.toBeInTheDocument()
    expect(backup.actions.dismissOperation).not.toHaveBeenCalled()
  })

  it("dismisses a stale import result whose sandbox no longer exists", async () => {
    const success: BackupOperation = { kind: "result", operation: "restore", archive, runningNames: [], targetName: "gone-sandbox", outcome: "success", title: "ready", message: "ok" }
    const backup = controller({ operation: success })
    render(<Harness backup={backup} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText("Imported gone-sandbox")).not.toBeInTheDocument()
    expect(backup.actions.dismissOperation).toHaveBeenCalled()
  })
})

describe("import notifications and popover", () => {
  it("validates the new name, blocks conflicts, offers a source select, and imports", async () => {
    const multi = { ...archive, sandboxes: ["dev", "api"] }
    const backup = controller({}, { chooseArchive: vi.fn().mockImplementation(async (onSelected?: (path: string) => void) => { onSelected?.("/p"); return { archive: multi, valid: true } }) })
    render(<Harness backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Start import" }))
    await act(async () => { await Promise.resolve() })
    const name = await screen.findByRole("textbox", { name: "New sandbox name" })
    expect(name).toHaveValue("dev-imported")
    expect(name).toHaveAttribute("autocapitalize", "off")
    expect(name).toHaveAttribute("autocorrect", "off")
    expect(name).toHaveAttribute("spellcheck", "false")
    expect(screen.getByRole("combobox", { name: "Sandbox to import" })).toBeInTheDocument()
    fireEvent.change(name, { target: { value: "Dev" } })
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
    fireEvent.change(name, { target: { value: "dev" } })
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
    fireEvent.change(name, { target: { value: "dev-copy" } })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await act(async () => { await Promise.resolve() })
    expect(backup.actions.startRestore).toHaveBeenCalledExactlyOnceWith(multi, "dev-copy", "dev")
  })

  it("closing the check stops it and never reopens the review with its late result", async () => {
    let signal: AbortSignal | undefined
    let finish: ((value: { archive: typeof archive; valid: boolean }) => void) | undefined
    const chooseArchive = vi.fn().mockImplementation((onSelected?: (path: string) => void, abort?: AbortSignal) => {
      onSelected?.("/p")
      signal = abort
      return new Promise(resolve => { finish = resolve })
    })
    render(<Harness backup={controller({}, { chooseArchive })} />)
    fireEvent.click(screen.getByRole("button", { name: "Start import" }))
    expect(await screen.findByText("Checking export")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await vi.waitFor(() => expect(screen.queryByText("Checking export")).not.toBeInTheDocument())
    expect(signal?.aborted).toBe(true)
    await act(async () => { finish?.({ archive, valid: true }) })
    expect(screen.queryByRole("textbox", { name: "New sandbox name" })).not.toBeInTheDocument()
    expect(screen.queryByText(`Import ${archive.name}`)).not.toBeInTheDocument()
  })

  it("reports an invalid export file in the popover and lets the user choose another", async () => {
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
    const { rerender } = render(<Harness backup={controller()} openSandbox={openSandbox} />)
    rerender(<Harness backup={controller({ operation: success })} openSandbox={openSandbox} />)
    expect(await screen.findByText(`Imported ${localVm.machine.name}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(openSandbox).toHaveBeenCalledWith(localVm.machine.id)
  })

  it("finds the imported sandbox when Open is clicked, even if it appeared after the toast", async () => {
    const openSandbox = vi.fn()
    const imported = { ...localVm, machine: { ...localVm.machine, id: "imported-id", name: "dev-copy" } }
    const withoutCopy = { ...source, workspaces: source.workspaces.filter(({ machine }) => machine.name !== "dev-copy") }
    const withCopy = { ...source, workspaces: [...withoutCopy.workspaces, imported] }
    const View = ({ backup, current }: { backup: BackupController; current: typeof source }) => {
      const transfer = useSandboxTransfer(backup, { source: current, openSandbox })
      return <SettingsProvider initialSettings={{ theme: "light" }}><Toaster />{transfer.importPopover(<button type="button">Add</button>)}</SettingsProvider>
    }
    const success: BackupOperation = { kind: "result", operation: "restore", archive, runningNames: [], targetName: "dev-copy", outcome: "success", title: "Import complete", message: "Sandbox imported." }
    const { rerender } = render(<View backup={controller()} current={withoutCopy} />)
    rerender(<View backup={controller({ operation: success })} current={withoutCopy} />)
    expect(await screen.findByText("Imported dev-copy")).toBeInTheDocument()
    // The application snapshot catches up after the toast was shown.
    rerender(<View backup={controller({ operation: success })} current={withCopy} />)
    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(openSandbox).toHaveBeenCalledWith("imported-id")
  })

  it("confirms before cancelling a running import", async () => {
    const running: BackupOperation = { kind: "running", operation: "restore", archive, runningNames: [], targetName: "dev-copy", progress: 30, phases: [{ title: "Create new sandbox", detail: "Writing managed disk data.", tone: "running" }] }
    const backup = controller({ operation: running })
    render(<Harness backup={backup} />)
    expect(await screen.findByText("Importing dev-copy")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    // Cancelling before the import saves its sandbox adds nothing; nothing is removed.
    expect(await screen.findByText("Stop importing? No sandbox is added.")).toBeInTheDocument()
    expect(screen.queryByText(/Remove/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(backup.actions.cancelOperation).toHaveBeenCalledOnce()
  })

  it("stops offering Cancel once the import is saving its sandbox", async () => {
    const running: BackupOperation = { kind: "running", operation: "restore", archive, runningNames: [], targetName: "dev-copy", progress: 90, canCancel: false, phases: [{ title: "Saving stopped workspace", detail: "", tone: "running" }] }
    render(<Harness backup={controller({ operation: running })} />)
    expect(await screen.findByText("Importing dev-copy")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })
})
