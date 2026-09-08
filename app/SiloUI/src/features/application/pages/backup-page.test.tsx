import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BackupPreview } from "@/fixtures/backup-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { useBackupFixture, useUnavailableBackup } from "@/fixtures/application-backup"
import { BackupPage } from "./backup-page"

const source = applicationSourceForScenario("running")

function selectArchive(name = "dev.silo-backup") {
  const input = screen.getByLabelText("Backup archive file")
  fireEvent.change(input, { target: { files: [new File(["archive"], name)] } })
}

async function finish() {
  for (let step = 0; step < 4; step += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
  }
}

describe("backup and restore presentation", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

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
    selectArchive()
    const review = screen.getByRole("group", { name: "Review restore" })
    expect(review).toHaveTextContent("Backup validated")
    expect(review).toHaveTextContent("Existing sandboxes and backups stay unchanged")
    const name = screen.getByRole("textbox", { name: "New sandbox name" })
    expect(name).toHaveValue("dev-restored")
    fireEvent.click(screen.getByRole("button", { name: "Restore new sandbox" }))
    await finish()
    expect(onRestoreComplete).toHaveBeenCalledOnce()
    expect(screen.getByRole("status")).toHaveTextContent("dev-restored is ready")
    expect(screen.getByRole("status")).toHaveTextContent("running programs were not")
  })

  it("blocks corrupt archives and removes incomplete new VMs after cancellation", () => {
    const invalid = render(<BackupPreview source={source} previewMode="invalid-archive" />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    selectArchive()
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be restored")
    invalid.unmount()

    render(<BackupPreview source={source} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }))
    selectArchive()
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
