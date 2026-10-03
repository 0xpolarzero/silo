import type { BackupArchive, BackupOperation } from "@/features/application/model/backup-source"
import type { TransferResultNotice, TransferResultNoticeBackend } from "@/features/application/model/transfer-result-notice"

/**
 * An export or import result Silo has not shown yet. `interrupted-import` and `interrupted-export`
 * are what an upgrade records for an operation it interrupted; `set-aside` is the notice that an
 * unreadable export or import record was renamed aside. After an upgrade the screen about the
 * pre-upgrade backup shows it (`view=migration`); wherever that screen does not appear, the
 * application shows it as an export and import notification (`view=app`).
 */
export const unseenResultFixtureModes = ["interrupted-import", "interrupted-export", "set-aside"] as const
export type UnseenResultFixtureMode = (typeof unseenResultFixtureModes)[number]

export function unseenResultFixtureModeFromSearch(search: string): UnseenResultFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("unseen-result")
  return unseenResultFixtureModes.find(mode => mode === requested)
}

const exportFile: BackupArchive = {
  name: "dev.silo-backup",
  archivePath: "/Users/ada/Exports/dev.silo-backup",
  completedLabel: "Not completed",
  size: "Unknown",
  destination: "/Users/ada/Exports",
  computers: ["dev"],
}

type Result = Extract<BackupOperation, { kind: "result" }>

/** The wording is the native recovery's, so the preview shows what a user would read. */
const results: Record<UnseenResultFixtureMode, Result> = {
  "interrupted-import": {
    kind: "result", operation: "restore", archive: exportFile, runningNames: [], targetName: "dev-imported", outcome: "failed",
    title: "Import interrupted before the upgrade",
    message: "Silo closed before this import finished.",
    detail: "No computer was added. Import the file again.",
  },
  "interrupted-export": {
    kind: "result", operation: "backup", archive: exportFile, runningNames: [], outcome: "failed",
    title: "Export interrupted before the upgrade",
    message: "Silo closed before this export finished.",
    detail: "No export file was saved. Export the computer again.",
  },
  "set-aside": {
    kind: "result", operation: "backup", outcome: "failed", runningNames: [],
    archive: { name: "Export or import record", archivePath: "/Users/ada/Library/Application Support/org.silo.dev/backup-operation.unreadable-2026-10-01.json", completedLabel: "Set aside", size: "Unknown", destination: "/Users/ada/Library/Application Support/org.silo.dev", computers: [] },
    title: "Export or import record set aside",
    message: "An export or import record couldn’t be read and was set aside.",
    detail: "If an export or import was running, run it again.",
  },
}

export interface FixtureUnseenResult extends TransferResultNoticeBackend {
  calls: string[]
  /** The result as the application's export and import state starts with it, and whether it is still unseen. */
  current: () => { operation: Result; unseen: boolean }
}

/** One result shared by the screen about the backup and the application, so acknowledging it on one is seen by the other. */
export function createFixtureUnseenResult(mode: UnseenResultFixtureMode): FixtureUnseenResult {
  const operation = results[mode]
  const id = `fixture-${mode}`
  const notice: TransferResultNotice = { id, operation: operation.operation, outcome: operation.outcome, title: operation.title, message: operation.message, ...(operation.detail && { detail: operation.detail }) }
  let unseen = true
  const listeners = new Set<() => void>()
  const calls: string[] = []
  return {
    calls,
    current: () => ({ operation, unseen }),
    read: async () => { calls.push("read"); return unseen ? notice : null },
    acknowledge: async (acknowledged) => {
      calls.push("acknowledge")
      if (acknowledged !== id) return
      unseen = false
      listeners.forEach(listener => listener())
    },
    subscribe: async refresh => { listeners.add(refresh); return () => { listeners.delete(refresh) } },
  }
}
