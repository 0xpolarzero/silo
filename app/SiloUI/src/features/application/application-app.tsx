import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"

import type { BackupController } from "@/features/application/model/backup-source"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { ApplicationShell, type ApplicationNavigationLoading } from "@/features/application/components/application-shell"
import { ApplicationCommandMenu } from "@/features/application/components/application-command-menu"
import { applicationCommands } from "@/features/application/components/application-commands"
import type { ApplicationActions, ApplicationSource, RepositoryPushOperation, RuntimeRepairPresentation, SandboxConfigurationOperation } from "@/features/application/model/application-source"
import { useApplicationNavigation, type ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { BackupPage } from "@/features/application/pages/backup-page"
import { GeneralPage } from "@/features/application/pages/general-page"
import { GitHubPage } from "@/features/application/pages/github-page"
import { NotificationsPage } from "@/features/application/pages/notifications-page"
import { OverviewPage } from "@/features/application/pages/overview-page"
import { SecretsPage } from "@/features/application/pages/secrets-page"
import { SystemIssuePage } from "@/features/application/pages/system-issue-page"
import { WorkspacesPage } from "@/features/application/pages/workspaces-page"
import { applicationPreferenceChanges, type ApplicationPreferenceSelection } from "@/features/preferences/model/application-preferences"
import { SettingsProvider, useSettings } from "@/features/preferences/settings-store"

function workspaceAttentionCounts(source: Pick<ApplicationSource, "workspaces" | "sandboxConfigurationOperation">): { errors: number; warnings: number } {
  const attentionByMachine = new Map(source.workspaces.map((workspace) => [
    workspace.machine.id,
    workspace.state === "failed" || workspace.attention?.level === "error"
      ? "error" as const
      : workspace.attention?.level === "warning"
        ? "warning" as const
        : null,
  ]))
  const operation = source.sandboxConfigurationOperation
  if (operation?.status === "failed" && operation.error.workspace) {
    const failedMachine = operation.candidate.machines.find(({ name }) => name === operation.error.workspace)
      ?? source.workspaces.find(({ machine }) => machine.name === operation.error.workspace)?.machine
    if (failedMachine) attentionByMachine.set(failedMachine.id, "error")
  }

  return [...attentionByMachine.values()].reduce((counts, attention) => {
    if (attention === "error") counts.errors += 1
    else if (attention === "warning") counts.warnings += 1
    return counts
  }, { errors: 0, warnings: 0 })
}

function navigationLoadingState(source: ApplicationSource, githubBusy: boolean, backupBusy: boolean): ApplicationNavigationLoading {
  const runningCategories = new Set(source.activities
    .filter(({ status }) => status === "running")
    .map(({ category }) => category))
  const activityBusy = runningCategories.size > 0
  const githubSourceBusy = source.github.state === "connecting"
    || (source.github.workspaceOperations ?? []).some(({ status }) => status === "applying")

  return {
    tabs: {
      github: githubBusy || githubSourceBusy || runningCategories.has("github"),
      secrets: runningCategories.has("secrets"),
      backup: backupBusy || runningCategories.has("backup"),
      system: source.runtimeRepair?.status === "repairing" || runningCategories.has("system"),
    },
    workspaceSections: {
      overview: source.sandboxConfigurationOperation?.status === "applying"
        || source.workspaces.some(({ state }) => state === "starting")
        || runningCategories.has("sandbox"),
      files: source.repositoryPushOperations.some(({ status }) => status === "pushing")
        || runningCategories.has("git"),
      activity: activityBusy,
    },
  }
}

type ApplicationAppProps = { source: ApplicationSource; actions: ApplicationActions; backup: BackupController; initialRoute?: ApplicationInitialRoute; routeRequest?: ApplicationInitialRoute }

export function ApplicationApp(props: ApplicationAppProps) {
  const initialWorkspace = props.source.workspaces.find(({ machine }) => machine.name === "dev") ?? props.source.workspaces[0]
  return <SettingsProvider initialSettings={{
    ...props.source.preferences,
    startupWorkspaceIds: props.source.preferences.startupWorkspaceIds ?? (initialWorkspace ? [initialWorkspace.machine.id] : []),
  }}><ApplicationContent {...props} /></SettingsProvider>
}

function ApplicationContent({ source, actions, backup, initialRoute, routeRequest }: ApplicationAppProps) {
  const { settings, updateSettings } = useSettings()
  const { reduceMotion } = settings
  const applicationPreferences: ApplicationPreferenceSelection = {
    terminal: settings.terminal,
    editor: settings.editor,
    browser: settings.browser,
    terminalUseSystemDefault: settings.terminalUseSystemDefault,
    editorUseSystemDefault: settings.editorUseSystemDefault,
    browserUseSystemDefault: settings.browserUseSystemDefault,
    ...(settings.terminalPath && { terminalPath: settings.terminalPath }),
    ...(settings.editorPath && { editorPath: settings.editorPath }),
    ...(settings.browserPath && { browserPath: settings.browserPath }),
  }
  const activeRuntimeRepair = source.runtimeRepair?.status === "succeeded" ? null : source.runtimeRepair
  const navigation = useApplicationNavigation(Boolean(activeRuntimeRepair), initialRoute)
  const { tab: activeTab, workspaceSection, settingsSection } = navigation
  const workspaces = source.workspaces
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<Set<string>>(() => new Set(
    source.workspaces
      .filter(({ machine }) => machine.name === initialRoute?.workspace || machine.id === initialRoute?.workspace)
      .map(({ machine }) => machine.id),
  ))
  const [logQuery, setLogQuery] = useState("")
  const [sandboxConfigurationOperation, setSandboxConfigurationOperation] = useState<SandboxConfigurationOperation | null>(source.sandboxConfigurationOperation)
  const [repositoryPushOperations, setRepositoryPushOperations] = useState<RepositoryPushOperation[]>(source.repositoryPushOperations)
  const [repairConfirmationVisible, setRepairConfirmationVisible] = useState(source.runtimeRepair?.status === "succeeded")
  const [backupBusy, setBackupBusy] = useState(false)
  const [githubBusy, setGitHubBusy] = useState(
    source.github.state === "connecting"
      || (source.github.workspaceOperations ?? []).some(({ status }) => status === "applying"),
  )
  const previousRuntimeRepairStatus = useRef<RuntimeRepairPresentation["status"] | undefined>(undefined)
  const repairConfirmationTimer = useRef<number | null>(null)
  const visibleTab = activeTab
  const visibleWorkspaceSection = workspaceSection
  const applicationSource = {
    ...source,
    workspaces,
    sandboxConfigurationOperation,
    repositoryPushOperations,
    preferences: { ...source.preferences, ...settings },
  }

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setSelectedWorkspaceIds((current) => {
      const availableIds = new Set(source.workspaces.map(({ machine }) => machine.id))
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [source.workspaces])

  useEffect(() => {
    // The native bridge clears or replaces the pending operation alongside its authoritative snapshot.
    // oxlint-disable-next-line react/set-state-in-effect
    setSandboxConfigurationOperation(source.sandboxConfigurationOperation)
    // The native bridge replaces local push progress with its authoritative operation result.
    // oxlint-disable-next-line react/set-state-in-effect
    setRepositoryPushOperations(source.repositoryPushOperations)
  }, [source.sandboxConfigurationOperation, source.repositoryPushOperations])

  function changeApplicationPreferences(next: ApplicationPreferenceSelection) {
    void updateSettings(applicationPreferenceChanges(applicationPreferences, next))
  }

  useEffect(() => {
    const status = source.runtimeRepair?.status
    const previousStatus = previousRuntimeRepairStatus.current
    previousRuntimeRepairStatus.current = status

    if (status && status !== "succeeded") {
      if (repairConfirmationTimer.current !== null) {
        window.clearTimeout(repairConfirmationTimer.current)
        repairConfirmationTimer.current = null
      }
      // oxlint-disable-next-line react/set-state-in-effect
      setRepairConfirmationVisible(false)
      return
    }
    if (status !== "succeeded" || previousStatus === "succeeded") return

    // A successful repair is a transient result, not a navigation destination.
    // oxlint-disable-next-line react/set-state-in-effect
    setRepairConfirmationVisible(true)
    if (repairConfirmationTimer.current !== null) window.clearTimeout(repairConfirmationTimer.current)
    repairConfirmationTimer.current = window.setTimeout(() => {
      setRepairConfirmationVisible(false)
      repairConfirmationTimer.current = null
    }, 4_000)
  }, [source.runtimeRepair?.status, activeTab])

  useEffect(() => () => {
    if (repairConfirmationTimer.current !== null) window.clearTimeout(repairConfirmationTimer.current)
  }, [])

  function updateMachines(machines: SetupMachineConfiguration[]) {
    const candidate = { schemaVersion: 1 as const, machines }
    setSandboxConfigurationOperation({
      id: "local-sandbox-configuration",
      status: "applying",
      candidate,
      progressEvents: [],
      result: null,
      error: null,
    })
    actions.saveMachineConfiguration(candidate)
  }

  function pushRepository(workspace: string, repositoryPath: string, commitCount: number) {
    setRepositoryPushOperations((current) => [
      ...current.filter((operation) => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath),
      { workspace, repositoryPath, commitCount, status: "pushing" },
    ])
    actions.pushRepository(workspace, repositoryPath)
  }

  const dismissRepositoryPush = useCallback((workspace: string, repositoryPath: string) => {
    setRepositoryPushOperations((current) => current.filter((operation) => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath))
  }, [])

  function navigateCommand(route: ApplicationInitialRoute) {
    if (route.workspaceSection && route.workspaceSection !== "overview") {
      setSelectedWorkspaceIds(new Set(source.workspaces
        .filter(({ machine }) => machine.id === route.workspace || machine.name === route.workspace)
        .map(({ machine }) => machine.id)))
    }
    if (route.workspaceSection) navigation.selectWorkspaceSection(route.workspaceSection)
    else if (route.settingsSection) navigation.selectSettingsSection(route.settingsSection)
    else if (route.tab) navigation.selectTab(route.tab)
  }

  const navigateRequested = useEffectEvent(navigateCommand)
  useEffect(() => {
    // Apply an external status-panel navigation request to the existing window.
    // oxlint-disable-next-line react/set-state-in-effect
    if (routeRequest) navigateRequested(routeRequest)
  }, [routeRequest])

  return (
    <ApplicationShell
      activeTab={visibleTab}
      workspaceSection={visibleWorkspaceSection}
      settingsSection={settingsSection}
      systemIssueStatus={activeRuntimeRepair?.status ?? null}
      workspaceAttention={workspaceAttentionCounts(applicationSource)}
      navigationLoading={navigationLoadingState(applicationSource, githubBusy, backupBusy)}
      onTabChange={navigation.selectTab}
      onWorkspaceSectionChange={navigation.selectWorkspaceSection}
      onSettingsSectionChange={navigation.selectSettingsSection}
      canGoBack={navigation.canGoBack}
      canGoForward={navigation.canGoForward}
      onGoBack={navigation.goBack}
      onGoForward={navigation.goForward}
      reduceMotion={reduceMotion}
      commandMenu={<ApplicationCommandMenu commands={applicationCommands(applicationSource, actions, navigateCommand)} />}
    >
      <section id="application-panel-workspaces" role="region" aria-labelledby="application-nav-workspaces" hidden={visibleTab !== "workspaces"} className="h-full min-h-0 overflow-hidden">
        {visibleWorkspaceSection === "overview" ? (
          <OverviewPage source={applicationSource} actions={actions} onMachinesChange={updateMachines} repairCompleted={repairConfirmationVisible} />
        ) : (
          <WorkspacesPage
            workspaces={workspaces}
            activities={source.activities}
            selectedWorkspaceIds={selectedWorkspaceIds}
            section={visibleWorkspaceSection}
            logQuery={logQuery}
            repositoryPushOperations={repositoryPushOperations}
            browser={applicationPreferences.browser}
            onWorkspaceFilterChange={setSelectedWorkspaceIds}
            onLogQueryChange={setLogQuery}
            onPushRepository={pushRepository}
            onDismissRepositoryPush={dismissRepositoryPush}
          />
        )}
      </section>
      <section id="application-panel-github" role="region" aria-labelledby="application-nav-github" hidden={visibleTab !== "github"} className="h-full min-h-0 overflow-hidden">
        <GitHubPage source={applicationSource} actions={actions} onBusyChange={setGitHubBusy} />
      </section>
      <section id="application-panel-secrets" role="region" aria-labelledby="application-nav-secrets" hidden={visibleTab !== "secrets"}><SecretsPage source={applicationSource} onSaveSecret={actions.saveSecret} onRemoveSecret={actions.removeSecret} /></section>
      <section id="application-panel-backup" role="region" aria-labelledby="application-nav-backup" hidden={visibleTab !== "backup"}><BackupPage source={applicationSource} backup={backup} onBusyChange={setBackupBusy} /></section>
      {activeRuntimeRepair && (
        <section id="application-panel-system" role="region" aria-labelledby="application-nav-system" hidden={visibleTab !== "system"}>
          <SystemIssuePage issue={activeRuntimeRepair} actions={actions} />
        </section>
      )}
      <section id="application-panel-settings" role="region" aria-labelledby="application-nav-settings" hidden={visibleTab !== "settings"}>
        <div hidden={settingsSection !== "general"}>
          <GeneralPage source={source} applicationPreferences={applicationPreferences} onApplicationPreferencesChange={changeApplicationPreferences} reduceMotion={reduceMotion} onReduceMotionChange={(enabled) => { void updateSettings({ reduceMotion: enabled }) }} />
        </div>
        <div hidden={settingsSection !== "notifications"}><NotificationsPage /></div>
      </section>
    </ApplicationShell>
  )
}
