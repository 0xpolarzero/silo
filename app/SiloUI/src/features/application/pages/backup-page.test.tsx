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

  it.each(["Dev", "1dev", "dev copy", "dev_copy", "", "a".repeat(33)])("explains invalid restore names at the input: %j", async (invalidName) => {
    const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", archives: [archive], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn().mockResolvedValue({ archive, valid: true }), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    const view = render(<BackupPage source={source} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    await act(async () => { await Promise.resolve() })
    const name = screen.getByRole("textbox", { name: "New sandbox name" })
    fireEvent.change(name, { target: { value: invalidName } })
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(name).toHaveAccessibleDescription("Use 1–32 lowercase letters, numbers, or hyphens, starting with a letter.")
    const confirm = screen.getByRole("button", { name: "Restore new sandbox" })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(backup.actions.startRestore).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: "my-copy-2" } })
    expect(name).toHaveAttribute("aria-invalid", "false")
    expect(name).not.toHaveAccessibleDescription()
    fireEvent.click(confirm)
    expect(backup.actions.startRestore).toHaveBeenCalledWith(archive, "my-copy-2", "dev")
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { ...backup.state, operation: { kind: "result", operation: "restore", archive, targetName: "my-copy-2", runningNames: [], outcome: "failed", title: "Restore failed", message: "Storage is unavailable." } } }} />)
    fireEvent.click(screen.getByRole("button", { name: "Review and retry" }))
    expect(screen.getByRole("textbox", { name: "New sandbox name" })).toHaveValue("my-copy-2")
    expect(backup.actions.chooseArchive).toHaveBeenCalledTimes(1)
    expect(backup.actions.inspectArchive).not.toHaveBeenCalled()
  })

  it("reveals the recent-backup confirmation even when the suggested name exists", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
    const existing = { ...source, workspaces: [...source.workspaces, { ...source.workspaces[0], machine: { ...source.workspaces[0].machine, id: "restored", name: "dev-restored" } }] }
    const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", archives: [archive], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn().mockResolvedValue({ archive, valid: true }), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    render(<BackupPage source={existing} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: `Details for ${archive.name}` }))
    fireEvent.click(screen.getByRole("button", { name: "Restore…" }))
    await act(async () => { await Promise.resolve() })
    const review = screen.getByRole("group", { name: "Review restore" })
    expect(scroll.mock.contexts).toContain(review)
    const name = within(review).getByRole("textbox", { name: "New sandbox name" })
    expect(name).toHaveFocus()
    expect(within(review).queryByRole("alert")).not.toBeInTheDocument()
    expect(name).toHaveAttribute("aria-invalid", "true")
    const confirm = within(review).getByRole("button", { name: "Restore new sandbox" })
    expect(confirm).toBeDisabled()
    expect(backup.actions.startRestore).not.toHaveBeenCalled()
    scroll.mockClear()
    fireEvent.change(name, { target: { value: "another-copy" } })
    expect(name).toHaveAttribute("aria-invalid", "false")
    expect(scroll).not.toHaveBeenCalled()
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(backup.actions.startRestore).toHaveBeenCalledWith(archive, "another-copy", "dev")
    scroll.mockRestore()
  })

  it.each(["recent", "picker"])("shows checking immediately, blocks conflicts, and requires confirmation (%s)", async (entry) => {
    const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }
    let complete!: (result: { archive: typeof archive; valid: boolean }) => void
    const pending = new Promise<{ archive: typeof archive; valid: boolean }>(resolve => { complete = resolve })
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", archives: [archive], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn((onSelected) => { onSelected?.(archive.archivePath); return pending }), inspectArchive: vi.fn(() => pending), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    const view = render(<BackupPage source={source} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: `Details for ${archive.name}` }))
    fireEvent.click(screen.getByRole("button", { name: entry === "recent" ? "Restore…" : "Choose backup…" }))
    expect(screen.getByRole("progressbar", { name: "Backup validation progress" })).not.toHaveAttribute("aria-valuenow")
    expect(screen.getByText("Checking…")).toBeVisible()
    expect(screen.getByRole("button", { name: "Create backup…" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Choose backup…" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Restore…" })).toBeDisabled()
    expect(backup.actions.startRestore).not.toHaveBeenCalled()
    await act(async () => { complete({ archive, valid: true }); await pending })
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Review restore" })).toBeVisible()
    expect(backup.actions.startRestore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Restore new sandbox" }))
    expect(backup.actions.startRestore).toHaveBeenCalledWith(archive, "dev-restored", "dev")
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { ...backup.state, operation: { kind: "running", operation: "restore", archive, runningNames: [], progress: 0, indeterminate: true, phases: [] } } }} />)
    expect(screen.getByText("Restoring…")).toBeVisible()
    expect(screen.getByRole("progressbar", { name: "Restore progress" })).not.toHaveAttribute("aria-valuenow")
    expect(screen.getByRole("button", { name: "Cancel restore…" })).toBeEnabled()
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { ...backup.state, operation: { kind: "running", operation: "restore", archive, runningNames: [], progress: 0, indeterminate: true, canCancel: false, phases: [] } } }} />)
    expect(screen.getByRole("button", { name: "Cancel restore…" })).toBeDisabled()
  })

  it("clears picker feedback when choosing a backup is cancelled", async () => {
    let complete!: (value: null) => void
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", archives: [], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(() => new Promise<null>(resolve => { complete = resolve })), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    render(<BackupPage source={source} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    expect(screen.getByRole("status")).toHaveTextContent("Choose a backup in the file picker.")
    await act(async () => { complete(null) })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create backup…" })).toBeEnabled()
  })

  it("automatically dismisses only success and never dismisses a newer operation", async () => {
    const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }
    const success = { kind: "result" as const, operation: "backup" as const, outcome: "success" as const, title: "Backup ready", message: "Long success description", archive, runningNames: [] }
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", archives: [archive], operation: success },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    const view = render(<BackupPage source={source} backup={backup} />)
    expect(screen.getByRole("status")).toHaveTextContent("Backup completed successfully.")
    expect(screen.queryByText("Long success description")).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(backup.actions.dismissOperation).toHaveBeenCalledTimes(1)
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { ...backup.state, operation: null } }} />)
    view.rerender(<BackupPage source={source} backup={backup} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { ...backup.state, operation: { kind: "running", operation: "restore", archive, runningNames: [], progress: 20, phases: [] } } }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(backup.actions.dismissOperation).toHaveBeenCalledTimes(1)
    view.rerender(<BackupPage source={source} backup={{ ...backup, state: { ...backup.state, operation: { ...success, outcome: "restart-required", title: "Restart failed" } } }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(screen.getByRole("status")).toHaveTextContent("Restart failed")
    expect(backup.actions.dismissOperation).toHaveBeenCalledTimes(1)
  })

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

  it.each([false, true])("drops deleted sandboxes from review and submission (removed during review: %s)", (duringReview) => {
    const initial = structuredClone(source)
    initial.workspaces = initial.workspaces.slice(0, 2).map(workspace => ({ ...workspace, state: "stopped" as const }))
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", destination: "/backups", archives: [], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    const view = render(<BackupPage source={initial} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    if (duringReview) fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    view.rerender(<BackupPage source={{ ...initial, workspaces: initial.workspaces.slice(0, 1) }} backup={backup} />)
    if (!duringReview) fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    const review = screen.getByRole("group", { name: "Review backup" })
    expect(review).toHaveTextContent("dev")
    expect(review).not.toHaveTextContent(initial.workspaces[1].machine.name)
    fireEvent.click(within(review).getByRole("button", { name: "Start backup" }))
    expect(backup.actions.startBackup).toHaveBeenCalledWith("/backups", ["dev"])
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
    view.rerender(<BackupPage source={{ ...initial, workspaces: [] }} backup={backup} />)
    expect(screen.getByRole("button", { name: "Start backup" })).toBeDisabled()
    expect(backup.actions.startBackup).toHaveBeenCalledTimes(1)
  })

  it("does not select a new sandbox that reuses a deleted name", () => {
    const initial = structuredClone(source)
    initial.workspaces = initial.workspaces.slice(0, 1).map(workspace => ({ ...workspace, state: "stopped" as const }))
    const backup: BackupController = {
      state: { snapshotId: "1", availability: "available", destination: "/backups", archives: [], operation: null },
      actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn(), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() },
    }
    const view = render(<BackupPage source={initial} backup={backup} />)
    fireEvent.click(screen.getByRole("button", { name: "Create backup…" }))
    const replacement = structuredClone(initial)
    replacement.workspaces[0].machine.id = "00000000-0000-4000-8000-000000000099"
    view.rerender(<BackupPage source={replacement} backup={backup} />)
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    expect(screen.getByRole("button", { name: "Review backup" })).toBeDisabled()
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
    expect(screen.getByRole("status")).toHaveTextContent("Backup completed successfully.")
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
    expect(screen.getByRole("status")).toHaveTextContent("Sandbox restored successfully.")
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
