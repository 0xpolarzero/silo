import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import userEvent from "@testing-library/user-event"
import { BackupPreview } from "@/fixtures/backup-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { useBackupFixture, useUnavailableBackup } from "@/fixtures/application-backup"
import type { BackupController } from "@/features/application/model/backup-source"
import { BackupPage } from "./backup-page"

const source = applicationSourceForScenario("running")

async function finish() {
  for (let step = 0; step < 4; step += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
  }
}

describe("backup and restore presentation", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("keeps an open review and edited name when native progress snapshots refresh", async () => {
    const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", requiredSpaceGB: 1.234567, availableSpaceGB: 19.987654, archives: [archive], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn().mockResolvedValue({ archive, valid: true }), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    const view = render(<BackupPage source={source} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByRole("textbox", { name: "New sandbox name" }), { target: { value: "my-restored-vm" } })
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { ...backup.state, snapshotId: "2" } }} />)
    expect(screen.getByRole("textbox", { name: "New sandbox name" })).toHaveValue("my-restored-vm")
    expect(screen.getByRole("group", { name: "Review restore" })).toHaveTextContent("1.3 GB needed · 19.9 GB available")
  })

  it("preserves unavailable error details without dismissing the native result", () => {
    const backup: BackupController = {
      state: { snapshotId: "error", availability: "unavailable", availabilityMessage: "Native restore state is invalid", archives: [], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    const view = render(<BackupPage source={source} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    expect(backup.actions.dismissOperation).not.toHaveBeenCalled()
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { snapshotId: "recovered", availability: "available", archives: [], operation: null } }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Native restore state is invalid")
  })

  it("uses the saved native backup destination after reopening", () => {
    const backup: BackupController = {
      state: { snapshotId: "saved", availability: "available", destination: "/Volumes/My Backups", archives: [], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    render(<BackupPage source={source} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    expect(screen.getByRole("textbox", { name: "Destination" })).toHaveValue("/Volumes/My Backups")
  })

  it("selects the VM within an archive and preserves a manually edited restore name", async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    const archive = { name: "vms.silo-backup", archivePath: "/backups/vms.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev", "personal"] }
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", archives: [archive], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn().mockResolvedValue({ archive, valid: true }), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    render(<BackupPage source={source} backup={backup} />)
    await user.click(screen.getByRole("button", { name: "Choose backup…" }))
    await user.click(screen.getByRole("combobox", { name: "Sandbox to restore" }))
    await user.click(screen.getByRole("option", { name: "personal" }))
    expect(screen.getByRole("textbox", { name: "New sandbox name" })).toHaveValue("personal-restored")
    expect(screen.getByRole("group", { name: "Review restore" })).not.toHaveTextContent("GB needed")
    fireEvent.change(screen.getByRole("textbox", { name: "New sandbox name" }), { target: { value: "my-copy" } })
    await user.click(screen.getByRole("combobox", { name: "Sandbox to restore" }))
    await user.click(screen.getByRole("option", { name: "dev" }))
    expect(screen.getByRole("textbox", { name: "New sandbox name" })).toHaveValue("my-copy")
    await user.click(screen.getByRole("button", { name: "Restore new sandbox" }))
    expect(backup.actions.startRestore).toHaveBeenCalledWith(archive, "my-copy", "dev")
  })

  it("selects sandboxes and explains the running interruption before capture", () => {
    render(<BackupPreview source={source} />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    expect(screen.getByRole("group", { name: "Choose backup" })).toHaveTextContent("devRunning")
    fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    const interruption = screen.getByRole("group", { name: "Running sandbox interruption" })
    expect(interruption).toHaveTextContent("save a disk copy")
    expect(interruption).toHaveTextContent("Programs inside the VM start fresh")
    expect(within(interruption).getByRole("button", { name: "Stop and back up" })).toBeEnabled()
  })

  it("blocks unsupported shared storage and a known destination shortage", () => {
    const unsupported = render(<BackupPreview source={source} previewMode="unsupported-storage" />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Complete backup is blocked")
    expect(screen.getByRole("alert")).toHaveTextContent("outside Silo’s managed disk")
    unsupported.unmount()

    render(<BackupPreview source={source} previewMode="space-blocked" />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    expect(screen.getByRole("alert")).toHaveTextContent("32 GB is needed; 19 GB is available")
  })

  it("shows per-phase progress, safe cancellation, and cleanup outcome", () => {
    render(<BackupPreview source={source} />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    fireEvent.click(screen.getByRole("button", { name: "Stop and back up" }))
    expect(screen.getByRole("progressbar", { name: "Backup progress" })).toBeVisible()
    expect(screen.getByText("Save disk copies")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Cancel backup…" }))
    expect(screen.getByRole("group", { name: "Cancel backup" })).toHaveTextContent("safe point")
    fireEvent.click(screen.getByRole("button", { name: "Cancel and clean up" }))
    expect(screen.getByRole("status")).toHaveTextContent("Backup cancelled")
    expect(screen.getByRole("status")).toHaveTextContent("Existing backups were not changed")
  })

  it("keeps verified backup success separate from restart failure and recovers", async () => {
    render(<BackupPreview source={source} previewMode="restart-required" />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    fireEvent.click(screen.getByRole("button", { name: "Stop and back up" }))
    await finish()
    expect(screen.getByRole("status")).toHaveTextContent("Backup ready; restart failed")
    fireEvent.click(screen.getByRole("button", { name: "Retry start" }))
    expect(screen.getByRole("status")).toHaveTextContent("dev is running again")
  })

  it("validates before review and restores to an editable new stopped sandbox", async () => {
    const onRestoreComplete = vi.fn()
    render(<BackupPreview source={source} onRestoreComplete={onRestoreComplete} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    await act(async () => { await Promise.resolve() })
    const review = screen.getByRole("group", { name: "Review restore" })
    expect(review).toHaveTextContent("Backup validated")
    expect(review).toHaveTextContent("Sourcedev")
    expect(review).toHaveTextContent("Existing sandboxes and backups stay unchanged")
    const name = screen.getByRole("textbox", { name: "New sandbox name" })
    expect(name).toHaveValue("dev-restored")
    fireEvent.click(screen.getByRole("button", { name: "Restore new sandbox" }))
    await finish()
    expect(onRestoreComplete).toHaveBeenCalledOnce()
    expect(screen.getByRole("status")).toHaveTextContent("dev-restored is ready")
    expect(screen.getByRole("status")).toHaveTextContent("running programs were not")
  })

  it("blocks corrupt archives and removes incomplete new VMs after cancellation", async () => {
    const invalid = render(<BackupPreview source={source} previewMode="invalid-archive" />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be restored")
    invalid.unmount()

    render(<BackupPreview source={source} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole("button", { name: "Restore new sandbox" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel restore…" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel and remove" }))
    expect(screen.getByRole("status")).toHaveTextContent("incomplete dev-restored sandbox was removed")
  })

  it("returns explicit unavailable behavior for native entry points without a backend", () => {
    function NativeUnavailable() { return <BackupPage source={source} backup={useUnavailableBackup(source)} /> }
    render(<NativeUnavailable />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    expect(screen.getByRole("alert")).toHaveTextContent("not available in this Silo build")
    expect(screen.queryByRole("status", { name: /completed/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    expect(screen.getByRole("group", { name: "Restore unavailable" })).toHaveTextContent("not available in this Silo build")
  })

  it("does not pass unknown destination capacity", () => {
    function UnknownSpace() {
      const backup = useBackupFixture({ source })
      return <BackupPage source={source} backup={{ ...backup, state: { ...backup.state, availableSpaceGB: undefined } }} />
    }
    render(<UnknownSpace />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Destination space is unavailable")
    expect(screen.queryByRole("button", { name: "Start backup" })).not.toBeInTheDocument()
  })
})
