import { useEffect, useState } from "react"

import type { BackupArchive, BackupController, BackupOperation, BackupOperationKind } from "@/features/application/model/backup-source"
import type { ApplicationSource } from "@/features/application/model/application-source"

export const backupFixtureModes = ["success", "backup-failed", "restart-required", "invalid-archive", "restore-failed"] as const
export type BackupFixtureMode = (typeof backupFixtureModes)[number]

export function backupFixtureModeFromSearch(search: string): BackupFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("backup-operation")
  return backupFixtureModes.find((mode) => mode === requested)
}

export function initialBackupArchive(source: ApplicationSource): BackupArchive {
  return {
    name: source.backup.lastArchive,
    completedLabel: source.backup.completedLabel,
    size: source.backup.compressedSize,
    destination: source.backup.destination,
    sandboxes: source.workspaces.filter(({ machine }) => machine.kind === "vm").map(({ machine }) => machine.name),
  }
}

export const backupRequiredGB = 48

export const backupProgressSteps = [
  { title: "Preparing backup", detail: "Flushing data and stopping running sandboxes.", progress: 10 },
  { title: "Writing archive", detail: "Compressing sandbox disks and persistent data.", progress: 45 },
  { title: "Verifying archive", detail: "Checking the archive and writing its checksum.", progress: 78 },
  { title: "Finishing backup", detail: "Restoring the previous sandbox running state.", progress: 95 },
]

export const restoreProgressSteps = [
  { title: "Preparing restore", detail: "Stopping sandboxes and preserving the current state.", progress: 10 },
  { title: "Extracting archive", detail: "Unpacking sandbox disks and persistent data.", progress: 45 },
  { title: "Restoring sandboxes", detail: "Applying the archived configuration and data.", progress: 78 },
  { title: "Verifying restore", detail: "Checking restored sandboxes before finishing.", progress: 95 },
]


interface BackupFixtureOptions {
  source: ApplicationSource
  previewMode?: BackupFixtureMode
  onRestoreComplete?: () => void
  onRestartRequired?: (sandboxes: string[]) => void
}

type RunningFixture = {
  operation: BackupOperationKind
  archive: BackupArchive
  runningNames: string[]
  step: number
}

export function useBackupFixture({ source, previewMode = "success", onRestoreComplete, onRestartRequired }: BackupFixtureOptions): BackupController {
  const snapshotId = `${JSON.stringify(source.backup)}:${previewMode}`
  const [currentSnapshot, setCurrentSnapshot] = useState(snapshotId)
  const [archives, setArchives] = useState<BackupArchive[]>(() => source.backup.lastArchive ? [initialBackupArchive(source)] : [])
  const [running, setRunning] = useState<RunningFixture | null>(null)
  const [result, setResult] = useState<BackupOperation | null>(null)

  if (currentSnapshot !== snapshotId) {
    setCurrentSnapshot(snapshotId)
    setArchives(source.backup.lastArchive ? [initialBackupArchive(source)] : [])
    setRunning(null)
    setResult(null)
  }

  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => {
      if (running.step < 3) {
        setRunning({ ...running, step: running.step + 1 })
        return
      }
      const failed = previewMode === `${running.operation}-failed`
      const needsRestart = running.operation === "backup" && previewMode === "restart-required" && running.runningNames.length > 0
      if (!failed && running.operation === "backup") setArchives((current) => [running.archive, ...current])
      if (!failed && running.operation === "restore") onRestoreComplete?.()
      if (needsRestart) onRestartRequired?.(running.runningNames)
      setResult({
        kind: "result", operation: running.operation, archive: running.archive, runningNames: running.runningNames,
        outcome: failed ? "failed" : needsRestart ? "restart-required" : "success",
        message: failed
          ? running.operation === "backup"
            ? "The destination disconnected while writing. No archive was saved; the previous sandbox running state was restored."
            : "The restored data could not be verified. Your previous sandbox state was recovered."
          : running.operation === "backup"
            ? "Archive saved and checksum verified."
            : "All restored sandboxes are stopped. Start them from Overview when ready.",
      })
      setRunning(null)
    }, 1_600)
    return () => window.clearTimeout(timer)
  }, [running, previewMode, onRestoreComplete, onRestartRequired])

  function start(operation: BackupOperationKind, archive: BackupArchive) {
    setResult(null)
    setRunning({
      operation, archive, step: 0,
      runningNames: source.workspaces.filter(({ machine, state }) => machine.kind === "vm" && state === "running").map(({ machine }) => machine.name),
    })
  }

  return {
    state: {
      snapshotId,
      requiredSpaceGB: backupRequiredGB,
      archives,
      operation: running ? {
        kind: "running", operation: running.operation, archive: running.archive, runningNames: running.runningNames,
        progress: (running.operation === "backup" ? backupProgressSteps : restoreProgressSteps)[running.step],
      } : result,
    },
    actions: {
      inspectArchive(selection) {
        // Only file metadata is used; archive contents and validation are simulated.
        const archive = selection instanceof File ? {
          ...initialBackupArchive(source), name: selection.name, destination: "", completedLabel: "Selected archive",
          size: selection.size >= 1024 ** 3 ? `${(selection.size / 1024 ** 3).toFixed(1)} GB` : `${(selection.size / 1024 ** 2).toFixed(1)} MB`,
        } : selection
        return { archive, valid: previewMode !== "invalid-archive" }
      },
      startBackup(destination) {
        const sandboxes = source.workspaces.filter(({ machine }) => machine.kind === "vm").map(({ machine }) => machine.name)
        if (!destination || sandboxes.length === 0) return
        start("backup", {
          name: `silo-${new Date().toISOString().slice(0, 10)}-${String(archives.length).padStart(3, "0")}.silo-backup`,
          completedLabel: "Just now", size: source.backup.compressedSize, destination, sandboxes,
        })
      },
      startRestore: (archive) => start("restore", archive),
      dismissOperation: () => setResult(null),
    },
  }
}
