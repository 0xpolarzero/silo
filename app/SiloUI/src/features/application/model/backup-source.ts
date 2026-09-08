export interface BackupArchive {
  name: string
  archivePath: string
  completedLabel: string
  size: string
  destination: string
  sandboxes: string[]
}

export type BackupOperationKind = "backup" | "restore"
export type BackupPhaseTone = "waiting" | "running" | "succeeded" | "failed"

export interface BackupPhase {
  title: string
  detail: string
  tone: BackupPhaseTone
}

export type BackupOperation = {
  operation: BackupOperationKind
  archive: BackupArchive
  runningNames: string[]
  targetName?: string
} & (
  | { kind: "running"; progress: number; phases: BackupPhase[] }
  | { kind: "result"; outcome: "success" | "failed" | "restart-required" | "cancelled"; title: string; message: string; detail?: string }
)

export interface BackupState {
  /** Changes when an authoritative replacement should discard the open review. */
  snapshotId: string
  availability: "available" | "unavailable"
  availabilityMessage?: string
  requiredSpaceGB?: number
  availableSpaceGB?: number
  unsupportedStorage?: { sandbox: string; label: string }
  destination?: string
  archives: BackupArchive[]
  operation: BackupOperation | null
}

export interface BackupActions {
  chooseDestination: () => Promise<string | null>
  chooseArchive: () => Promise<{ archive: BackupArchive; valid: boolean; reason?: string } | null>
  inspectArchive: (selection: BackupArchive) => Promise<{ archive: BackupArchive; valid: boolean; reason?: string }>
  startBackup: (destination: string, sandboxes: string[]) => void
  startRestore: (archive: BackupArchive, newName: string, sourceName?: string) => void
  cancelOperation: () => void
  retryStart: (sandbox: string) => void
  dismissOperation: () => void
}

export interface BackupController {
  state: BackupState
  actions: BackupActions
}
