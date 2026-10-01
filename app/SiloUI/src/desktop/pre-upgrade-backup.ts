import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { z } from "zod"

import { preUpgradeBackupSchema, type PreUpgradeBackupBackend } from "@/features/storage/pre-upgrade-backup"

export const desktopPreUpgradeBackupBackend: PreUpgradeBackupBackend = {
  read: async () => preUpgradeBackupSchema.nullable().parse(await invoke("read_pre_upgrade_backup")),
  measure: async () => z.number().int().nonnegative().nullable().parse(await invoke("measure_pre_upgrade_backup")),
  reveal: async () => { await invoke("reveal_pre_upgrade_backup") },
  remove: async () => { await invoke("delete_pre_upgrade_backup") },
  acknowledge: async () => { await invoke("acknowledge_pre_upgrade_backup_notice") },
  subscribe: refresh => listen("silo://pre-upgrade-backup-changed", refresh),
}
