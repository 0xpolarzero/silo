import { useEffect, useState } from "react"

import type { BackupArchive, BackupController, BackupOperation, BackupOperationKind, BackupPhase } from "@/features/application/model/backup-source"
import type { ApplicationSource } from "@/features/application/model/application-source"

export const backupFixtureModes = [
  "success", "backup-failed", "restart-required", "invalid-archive", "restore-failed",
  "unsupported-storage", "space-blocked", "stop-failed", "capture-failed", "cancel-backup",
  "restore-conflict", "restore-storage", "cancel-restore",
] as const
export type BackupFixtureMode = (typeof backupFixtureModes)[number]

export function backupFixtureModeFromSearch(search: string): BackupFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("backup-operation")
  return backupFixtureModes.find((mode) => mode === requested)
}

export function initialBackupArchive(source: ApplicationSource): BackupArchive {
  return {
    name: source.backup.lastArchive,
    archivePath: `${source.backup.destination}/${source.backup.lastArchive}`,
    completedLabel: source.backup.completedLabel,
    size: source.backup.compressedSize,
    destination: source.backup.destination,
    sandboxes: source.workspaces.filter(({ machine }) => machine.kind === "vm").map(({ machine }) => machine.name),
  }
}

const backupPhases: Array<[string, string]> = [
  ["Stop selected sandboxes", "Stopping running sandboxes cleanly."],
  ["Save disk copies", "Saving each managed disk."],
  ["Restart previous sandboxes", "Restarting sandboxes after capture."],
  ["Write and verify backup", "Writing a self-contained backup."],
]
const restorePhases: Array<[string, string]> = [
  ["Validate backup", "Checking the manifest and checksum."],
  ["Create new sandbox", "Writing managed disk data."],
  ["Apply Silo settings", "Restoring the saved VM settings."],
  ["Verify new sandbox", "Checking the new stopped sandbox."],
]

function phasesFor(operation: BackupOperationKind, step: number): BackupPhase[] {
  return (operation === "backup" ? backupPhases : restorePhases).map(([title, detail], index) => ({
    title,
    detail: index < step ? (operation === "backup" && index === 2 ? "Previously running sandboxes restarted." : "Completed.") : detail,
    tone: index < step ? "succeeded" as const : index === step ? "running" as const : "waiting" as const,
  }))
}

interface BackupFixtureOptions {
  source: ApplicationSource
  previewMode?: BackupFixtureMode
  onRestoreComplete?: (targetName: string) => void
  onRestartRequired?: (sandboxes: string[]) => void
}

type RunningFixture = { operation: BackupOperationKind; archive: BackupArchive; runningNames: string[]; targetName?: string; step: number }

function resultFor(running: RunningFixture, mode: BackupFixtureMode): Extract<BackupOperation, { kind: "result" }> {
  const common = { operation: running.operation, archive: running.archive, runningNames: running.runningNames, ...(running.targetName && { targetName: running.targetName }) }
  if (running.operation === "backup") {
    if (mode === "restart-required") return { ...common, kind: "result", outcome: "restart-required", title: "Backup ready; restart failed", message: "The backup is complete and verified. dev remains stopped because its restart failed.", detail: "No backup data was lost." }
    if (mode === "stop-failed") return { ...common, kind: "result", outcome: "failed", title: "Backup stopped before disk capture", message: "dev did not stop cleanly. Silo did not force it to terminate.", detail: "No backup file was created." }
    if (mode === "capture-failed") return { ...common, kind: "result", outcome: "failed", title: "Could not save the disk copy", message: "dev restarted successfully. No backup file was created.", detail: "Earlier backups were not changed." }
    if (mode === "backup-failed") return { ...common, kind: "result", outcome: "failed", title: "Backup could not be verified", message: "The destination disconnected while writing. The incomplete temporary file was removed.", detail: "Previously running sandboxes restarted. Earlier backups were not changed." }
    return { ...common, kind: "result", outcome: "success", title: "Backup ready", message: `${running.archive.name} · ${running.archive.size} · checksum verified`, detail: `Saved in ${running.archive.destination}. Previously running sandboxes restarted.` }
  }
  if (mode === "restore-failed") return { ...common, kind: "result", outcome: "failed", title: "Restore did not complete", message: `The new disk failed verification. The incomplete ${running.targetName} sandbox was removed.`, detail: "The backup file and existing sandboxes were not changed." }
  return { ...common, kind: "result", outcome: "success", title: `${running.targetName} is ready`, message: "The new sandbox was restored and verified. It is stopped.", detail: "Disk files and settings were restored; running programs were not." }
}

export function useBackupFixture({ source, previewMode = "success", onRestoreComplete, onRestartRequired }: BackupFixtureOptions): BackupController {
  const snapshotId = `${JSON.stringify(source.backup)}:${previewMode}`
  const [archives, setArchives] = useState<BackupArchive[]>(() => source.backup.lastArchive ? [initialBackupArchive(source)] : [])
  const [running, setRunning] = useState<RunningFixture | null>(null)
  const [result, setResult] = useState<BackupOperation | null>(null)

  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => {
      if (running.step < 3) { setRunning({ ...running, step: running.step + 1 }); return }
      const result = resultFor(running, previewMode)
      if (result.outcome === "success" && running.operation === "backup") setArchives((current) => [running.archive, ...current])
      if (result.outcome === "success" && running.operation === "restore" && running.targetName) onRestoreComplete?.(running.targetName)
      if (result.outcome === "restart-required") onRestartRequired?.(running.runningNames)
      setResult(result)
      setRunning(null)
    }, 900)
    return () => window.clearTimeout(timer)
  }, [running, previewMode, onRestoreComplete, onRestartRequired])

  function start(operation: BackupOperationKind, archive: BackupArchive, selected: string[], targetName?: string) {
    setResult(null)
    setRunning({ operation, archive, targetName, step: 0, runningNames: source.workspaces.filter(({ machine, state }) => selected.includes(machine.name) && state === "running").map(({ machine }) => machine.name) })
  }

  return {
    state: {
      snapshotId,
      availability: "available",
      requiredSpaceGB: previewMode === "restore-storage" ? 24 : 32,
      availableSpaceGB: previewMode === "space-blocked" ? 19 : previewMode === "restore-storage" ? 15 : 86,
      unsupportedStorage: previewMode === "unsupported-storage" ? { sandbox: "dev", label: "Client files" } : undefined,
      archives,
      operation: running ? { kind: "running", operation: running.operation, archive: running.archive, runningNames: running.runningNames, ...(running.targetName && { targetName: running.targetName }), progress: 18 + running.step * 25, phases: phasesFor(running.operation, running.step) } : result,
    },
    actions: {
      async chooseDestination() { return source.backup.destination },
      async chooseArchive() {
        const archive = { ...initialBackupArchive(source), name: "dev.silo-backup", archivePath: "/selected/dev.silo-backup", destination: "Selected file", completedLabel: "Selected archive", size: "12.4 GB" }
        return previewMode === "invalid-archive" ? { archive, valid: false, reason: "The checksum does not match, or this backup format is newer than this Silo version." } : { archive, valid: true }
      },
      async inspectArchive(selection) {
        const archive = selection
        return previewMode === "invalid-archive" ? { archive, valid: false, reason: "The checksum does not match, or this backup format is newer than this Silo version." } : { archive, valid: true }
      },
      startBackup(destination, sandboxes) {
        const name = `silo-${new Date().toISOString().slice(0, 10)}-${sandboxes.join("-")}.silo-backup`
        start("backup", { name, archivePath: `${destination}/${name}`, completedLabel: "Just now", size: source.backup.compressedSize, destination, sandboxes }, sandboxes)
      },
      startRestore: (archive, newName) => start("restore", archive, archive.sandboxes, newName),
      cancelOperation() {
        if (!running) return
        setResult({ operation: running.operation, archive: running.archive, runningNames: running.runningNames, ...(running.targetName && { targetName: running.targetName }), kind: "result", outcome: "cancelled", title: running.operation === "backup" ? "Backup cancelled" : "Restore cancelled", message: running.operation === "backup" ? "The incomplete file was removed. Previously running sandboxes restarted." : `The incomplete ${running.targetName} sandbox was removed.`, detail: running.operation === "backup" ? "Existing backups were not changed." : "The backup file and existing sandboxes were not changed." })
        setRunning(null)
      },
      retryStart(sandbox) { setResult((current) => current && { ...current, outcome: "success", title: "Backup ready", message: `${sandbox} is running again. The backup remains complete and verified.` }) },
      dismissOperation: () => setResult(null),
    },
  }
}

export function useUnavailableBackup(source: ApplicationSource): BackupController {
  return {
    state: { snapshotId: JSON.stringify(source.backup), availability: "unavailable", availabilityMessage: "Backup and restore are not available in this Silo build. No sandbox data was changed.", requiredSpaceGB: 0, archives: [], operation: null },
    actions: {
      chooseDestination: async () => null,
      chooseArchive: async () => null,
      inspectArchive: async (selection) => ({ archive: selection, valid: false, reason: "Native restore validation is unavailable in this Silo build." }),
      startBackup: () => undefined,
      startRestore: () => undefined,
      cancelOperation: () => undefined,
      retryStart: () => undefined,
      dismissOperation: () => undefined,
    },
  }
}
