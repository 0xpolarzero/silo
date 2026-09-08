import type { ApplicationSource } from "@/features/application/model/application-source"
import { BackupPage } from "@/features/application/pages/backup-page"
import { useBackupFixture, type BackupFixtureMode } from "@/fixtures/application-backup"

export function BackupPreview(props: {
  source: ApplicationSource
  previewMode?: BackupFixtureMode
  onBusyChange?: (busy: boolean) => void
  onRestoreComplete?: (targetName: string) => void
  onRestartRequired?: (sandboxes: string[]) => void
}) {
  const backup = useBackupFixture(props)
  return <BackupPage source={props.source} backup={backup} onBusyChange={props.onBusyChange} />
}
