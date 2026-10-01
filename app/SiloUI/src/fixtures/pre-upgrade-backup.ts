import type { RuntimeMigrationBackend, RuntimeMigrationState } from "@/desktop/runtime-migration-boundary"
import type { PreUpgradeBackup, PreUpgradeBackupBackend } from "@/features/storage/pre-upgrade-backup"

/**
 * `present`: a backup with a date. `no-date`: Silo cannot read its saved date, so it never deletes
 * the backup by itself. `delete-fails`: the first deletion fails and a retry succeeds.
 * `read-fails`: Silo cannot check for the backup; Retry succeeds.
 */
export const preUpgradeBackupFixtureModes = ["present", "no-date", "delete-fails", "read-fails"] as const
export type PreUpgradeBackupFixtureMode = (typeof preUpgradeBackupFixtureModes)[number]

export function preUpgradeBackupFixtureModeFromSearch(search: string): PreUpgradeBackupFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("pre-upgrade-backup")
  return preUpgradeBackupFixtureModes.find(mode => mode === requested)
}

// Midday UTC, so the local date is the same in every time zone from UTC-11 to UTC+11.
export const fixtureDeleteAt = "2026-10-15T12:00:00Z"
export const fixtureBackupBytes = Math.round(12.4 * 1024 ** 3)
export const fixtureDeleteFailure = "Silo could not finish deleting the pre-upgrade backup: Permission denied (os error 13). Your sandboxes were not affected. Try again."

export interface PreUpgradeBackupFixtureOptions {
  deleteAt?: string | null
  sizeBytes?: number
  noticePending?: boolean
  /** Deletions that fail before one succeeds. */
  failures?: number
  /** Time a deletion takes, so its progress can be seen. */
  delayMs?: number
  /** Start without a backup. */
  gone?: boolean
}

/** An in-memory backup that behaves like the native one, deterministically. */
export function createFixturePreUpgradeBackup(options: PreUpgradeBackupFixtureOptions = {}): PreUpgradeBackupBackend & { calls: string[] } {
  let present = !options.gone
  let noticePending = options.noticePending ?? true
  let failures = options.failures ?? 0
  const listeners = new Set<() => void>()
  const calls: string[] = []
  const changed = () => listeners.forEach(listener => listener())
  const backup = (): PreUpgradeBackup | null => present ? { deleteAt: options.deleteAt === undefined ? fixtureDeleteAt : options.deleteAt, noticePending } : null
  return {
    calls,
    read: async () => { calls.push("read"); return backup() },
    measure: async () => { calls.push("measure"); return present ? options.sizeBytes ?? fixtureBackupBytes : null },
    reveal: async () => {
      calls.push("reveal")
      if (!present) throw new Error("The pre-upgrade backup has already been deleted.")
    },
    remove: async () => {
      calls.push("remove")
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (failures > 0) { failures -= 1; throw new Error(fixtureDeleteFailure) }
      present = false
      changed()
    },
    acknowledge: async () => { calls.push("acknowledge"); noticePending = false },
    subscribe: async refresh => { listeners.add(refresh); return () => { listeners.delete(refresh) } },
  }
}

export function fixtureBackupForMode(mode: PreUpgradeBackupFixtureMode, delayMs = 0) {
  if (mode === "read-fails") {
    const backend = createFixturePreUpgradeBackup({ delayMs })
    let reads = 0
    const read = backend.read
    return { ...backend, read: async () => { if (reads++ === 0) throw new Error("Silo application storage is unavailable."); return read() } }
  }
  return createFixturePreUpgradeBackup({ delayMs, deleteAt: mode === "no-date" ? null : undefined, failures: mode === "delete-fails" ? 1 : 0 })
}

export const fixtureCompletedMigration: RuntimeMigrationState = {
  status: "complete", stage: "Migration complete", logs: [], migratedCount: 2, failedCount: 0, totalCount: 2, canContinue: false,
}

/** A migration that has just completed, with the fixture backup left behind. */
export function createFixtureMigrationBackend(preUpgradeBackup: PreUpgradeBackupBackend): RuntimeMigrationBackend {
  return {
    read: async () => fixtureCompletedMigration,
    retry: async () => fixtureCompletedMigration,
    continueAfterFailure: async () => fixtureCompletedMigration,
    subscribe: async () => () => {},
    preUpgradeBackup,
  }
}
