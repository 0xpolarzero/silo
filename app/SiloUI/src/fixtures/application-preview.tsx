import { useState } from "react"
import { useApplicationFixture } from "@/fixtures/application-state"
import { ApplicationApp } from "@/features/application/application-app"
import type { ApplicationActions, ApplicationSource } from "@/features/application/model/application-source"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { useBackupFixture, useUnavailableBackup, type BackupFixtureMode } from "@/fixtures/application-backup"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { fixtureApplicationCatalog } from "@/fixtures/application-catalog"
import { SettingsProvider, useSettings } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

const inactiveApplicationActions: ApplicationActions = {
  saveSecret: () => undefined,
  removeSecret: () => undefined,
  retryRuntimeChecks: () => undefined,
  saveMachineConfiguration: () => undefined,
  retryMachineConfiguration: () => undefined,
  pushRepository: () => undefined,
  startWorkspace: () => undefined,
  stopWorkspace: () => undefined,
  restartWorkspace: () => undefined,
  openTerminal: () => undefined,
  openEditor: () => undefined,
  disconnectGitHub: () => undefined,
}

export function ApplicationPreview({ source, actions, backupPreviewMode, initialRoute, nativeOperations = false }: {
  source: ApplicationSource
  actions?: Partial<ApplicationActions>
  backupPreviewMode?: BackupFixtureMode
  initialRoute?: ApplicationInitialRoute
  nativeOperations?: boolean
}) {
  const { store } = useSettings(source.preferences)
  const [systemIntegrations] = useState(() => createFixtureSystemIntegrationStore(store))
  const application = nativeOperations
    ? <UnavailableApplicationPreview source={source} actions={actions} initialRoute={initialRoute} />
    : <FixtureApplicationPreview source={source} actions={actions} backupPreviewMode={backupPreviewMode} initialRoute={initialRoute} />
  return <SettingsProvider store={store}><SystemIntegrationProvider store={systemIntegrations}>{application}</SystemIntegrationProvider></SettingsProvider>
}

function FixtureApplicationPreview({ source, actions, backupPreviewMode, initialRoute }: Parameters<typeof ApplicationPreview>[0]) {
  const fixture = useApplicationFixture(source)
  const backup = useBackupFixture({
    source: fixture.source,
    previewMode: backupPreviewMode,
    onRestoreComplete: fixture.onRestoreComplete,
    onRestartRequired: fixture.onRestartRequired,
  })

  return <ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}><ApplicationApp
    source={fixture.source}
    initialRoute={initialRoute}
    routeRequest={initialRoute}
    backup={backup}
    actions={{
      ...inactiveApplicationActions,
      ...actions,
      saveSecret: (request) => {
        fixture.saveSecret(request)
        actions?.saveSecret?.(request)
      },
      removeSecret: (id) => {
        fixture.removeSecret(id)
        actions?.removeSecret?.(id)
      },
    }}
  /></ApplicationCatalogProvider>
}

function UnavailableApplicationPreview({ source, actions, initialRoute }: Parameters<typeof ApplicationPreview>[0]) {
  const backup = useUnavailableBackup(source)
  return <ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}><ApplicationApp source={{ ...source, vmOperationsUnavailable: "VM operations are not available in this Silo build. No sandbox state was changed." }} initialRoute={initialRoute} routeRequest={initialRoute} backup={backup} actions={{ ...inactiveApplicationActions, ...actions }} /></ApplicationCatalogProvider>
}
