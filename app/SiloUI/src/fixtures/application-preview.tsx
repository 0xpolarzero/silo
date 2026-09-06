import { useApplicationFixture } from "@/fixtures/application-state"
import { ApplicationApp } from "@/features/application/application-app"
import type { ApplicationActions, ApplicationSource } from "@/features/application/model/application-source"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { useBackupFixture, type BackupFixtureMode } from "@/fixtures/application-backup"

const inactiveApplicationActions: ApplicationActions = {
  removeSecret: () => undefined,
  repairRuntime: () => undefined,
  saveMachineConfiguration: () => undefined,
  retryMachineConfiguration: () => undefined,
  pushRepository: () => undefined,
  startWorkspace: () => undefined,
  pauseWorkspace: () => undefined,
  stopWorkspace: () => undefined,
  restartWorkspace: () => undefined,
  openTerminal: () => undefined,
  openEditor: () => undefined,
  disconnectGitHub: () => undefined,
}

export function ApplicationPreview({ source, actions, backupPreviewMode, initialRoute }: {
  source: ApplicationSource
  actions?: Partial<ApplicationActions>
  backupPreviewMode?: BackupFixtureMode
  initialRoute?: ApplicationInitialRoute
}) {
  const fixture = useApplicationFixture(source)
  const backup = useBackupFixture({
    source: fixture.source,
    previewMode: backupPreviewMode,
    onRestoreComplete: fixture.onRestoreComplete,
    onRestartRequired: fixture.onRestartRequired,
  })

  return <ApplicationApp
    source={fixture.source}
    initialRoute={initialRoute}
    routeRequest={initialRoute}
    backup={backup}
    actions={{
      ...inactiveApplicationActions,
      ...actions,
      removeSecret: (id) => {
        fixture.removeSecret(id)
        actions?.removeSecret?.(id)
      },
    }}
  />
}
