import { fixtureLogPage, type LogLoader } from "@/features/application/model/logs"
import { useMemo, useState } from "react"
import { fixtureDirectoryLoader } from "./directory-loader"
import { useApplicationFixture } from "@/fixtures/application-state"
import { ApplicationApp } from "@/features/application/application-app"
import type { ApplicationActions, ApplicationSource, SshAccessRequest, SshAccessWorkspace } from "@/features/application/model/application-source"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { useBackupFixture, useUnavailableBackup, type BackupFixtureMode } from "@/fixtures/application-backup"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { fixtureApplicationCatalog } from "@/fixtures/application-catalog"
import { SettingsProvider, useSettings } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

const inactiveApplicationActions: ApplicationActions = {
  openNetworkPort: async () => undefined,
  saveSecret: () => undefined,
  removeSecret: () => undefined,
  retryRuntimeChecks: () => undefined,
  saveMachineConfiguration: () => undefined,
  dismissMachineConfigurationError: () => undefined,
  retryMachineConfiguration: () => undefined,
  pushRepository: () => undefined,
  startWorkspace: () => undefined,
  stopWorkspace: () => undefined,
  restartWorkspace: () => undefined,
  dismissWorkspaceError: () => undefined,
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
  const [sshSettings, setSshSettings] = useState<Record<string, SshAccessRequest>>({})
  const sshAccess = { workspaces: fixture.source.workspaces.filter(w => w.machine.kind === "vm").map((w, index): SshAccessWorkspace => {
    const settings = sshSettings[w.machine.name] ?? { workspace: w.machine.name, enabled: index === 0, port: 2222 + index, bindAddress: "127.0.0.1", keys: [] }
    return { ...settings, state: !settings.enabled ? "disabled" : w.state === "running" ? "listening" : "waiting", message: null, fingerprint: settings.enabled ? "SHA256:fixtureHostKeyForVisualPreviewOnly" : null, computerName: "Ada’s Mac mini", addresses: ["127.0.0.1", "192.168.1.42"] }
  }) }

  const queryLogs = useMemo<LogLoader>(() => async request => {
    const workspace = fixture.source.workspaces.find(item => (item.computer?.vmId ?? item.machine.id) === request.sandboxId && item.computer?.id === request.computerId)
    if (!workspace) throw new Error("Sandbox unavailable")
    return fixtureLogPage(workspace, request)
  }, [fixture.source.workspaces])
  const listWorkspaceDirectory = useMemo(() => fixtureDirectoryLoader(source.workspaces), [source.workspaces])
  const backup = useBackupFixture({
    source: fixture.source,
    previewMode: backupPreviewMode,
    onRestoreComplete: fixture.onRestoreComplete,
    onRestartRequired: fixture.onRestartRequired,
  })

  return <ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}><ApplicationApp
    source={{ ...fixture.source, sshAccess, network: fixture.source.network ?? { workspaces: fixture.source.workspaces.map(w => ({ workspace:w.machine.name,error:null,ports:w.ports.map(p => ({port:p.port,hostPort:p.port,scheme:"http" as const,state:p.listening === true ? "reachable" as const : p.listening === false ? "waiting" as const : "unknown" as const,configured:true})) })) } }}
    initialRoute={initialRoute}
    routeRequest={initialRoute}
    backup={backup}
    actions={{
      ...inactiveApplicationActions,
      saveSshAccess: async request => { setSshSettings(current => ({ ...current, [request.workspace]: request })) },
      listWorkspaceDirectory,
      queryLogs,
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
