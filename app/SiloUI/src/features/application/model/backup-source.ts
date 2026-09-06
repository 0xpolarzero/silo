export interface BackupArchive {
  name: string
  completedLabel: string
  size: string
  destination: string
  sandboxes: string[]
}

export type BackupOperationKind = "backup" | "restore"

export type BackupOperation = {
  operation: BackupOperationKind
  archive: BackupArchive
  runningNames: string[]
} & (
  | { kind: "running"; progress: { title: string; detail: string; progress: number } }
  | { kind: "result"; outcome: "success" | "failed" | "restart-required"; message: string }
)

export interface BackupState {
  /** Changes when an authoritative replacement should discard the open review. */
  snapshotId: string
  requiredSpaceGB: number
  archives: BackupArchive[]
  operation: BackupOperation | null
}

export interface BackupActions {
  inspectArchive: (selection: BackupArchive | File) => { archive: BackupArchive; valid: boolean }
  startBackup: (destination: string) => void
  startRestore: (archive: BackupArchive) => void
  dismissOperation: () => void
}

export interface BackupController {
  state: BackupState
  actions: BackupActions
}
