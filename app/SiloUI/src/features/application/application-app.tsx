import { useCallback, useEffect, useRef, useState } from "react"

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
import type { ApplicationPreferenceSelection } from "@/features/preferences/model/application-preferences"

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

export function ApplicationApp({ source, actions, backup, initialRoute }: { source: ApplicationSource; actions: ApplicationActions; backup: BackupController; initialRoute?: ApplicationInitialRoute }) {
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
  const [reduceMotion, setReduceMotion] = useState(source.preferences.reduceMotion)
  const [sandboxConfigurationOperation, setSandboxConfigurationOperation] = useState<SandboxConfigurationOperation | null>(source.sandboxConfigurationOperation)
  const [repositoryPushOperations, setRepositoryPushOperations] = useState<RepositoryPushOperation[]>(source.repositoryPushOperations)
  const [repairConfirmationVisible, setRepairConfirmationVisible] = useState(source.runtimeRepair?.status === "succeeded")
  const [backupBusy, setBackupBusy] = useState(false)
  const [githubBusy, setGitHubBusy] = useState(
    source.github.state === "connecting"
      || (source.github.workspaceOperations ?? []).some(({ status }) => status === "applying"),
  )
  const [applicationPreferences, setApplicationPreferences] = useState<ApplicationPreferenceSelection>(() => ({
    terminal: source.preferences.terminal,
    editor: source.preferences.editor,
    browser: source.preferences.browser,
  }))
  const previousRuntimeRepairStatus = useRef<RuntimeRepairPresentation["status"] | undefined>(undefined)
  const repairConfirmationTimer = useRef<number | null>(null)
  const visibleTab = activeTab
  const visibleWorkspaceSection = workspaceSection
  const applicationSource = {
    ...source,
    workspaces,
    sandboxConfigurationOperation,
    repositoryPushOperations,
    preferences: { ...source.preferences, ...applicationPreferences },
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
    // Keep local application choices aligned with a replacement native snapshot.
    // oxlint-disable-next-line react/set-state-in-effect
    setApplicationPreferences({
      terminal: source.preferences.terminal,
      editor: source.preferences.editor,
      browser: source.preferences.browser,
    })
    // oxlint-disable-next-line react/set-state-in-effect
    setReduceMotion(source.preferences.reduceMotion)
  }, [source.sandboxConfigurationOperation, source.repositoryPushOperations, source.preferences.terminal, source.preferences.editor, source.preferences.browser, source.preferences.reduceMotion])

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
    if (route.workspace) setSelectedWorkspaceIds(new Set([route.workspace]))
    if (route.workspaceSection) navigation.selectWorkspaceSection(route.workspaceSection)
    else if (route.settingsSection) navigation.selectSettingsSection(route.settingsSection)
    else if (route.tab) navigation.selectTab(route.tab)
  }

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
      <section id="application-panel-secrets" role="region" aria-labelledby="application-nav-secrets" hidden={visibleTab !== "secrets"}><SecretsPage source={applicationSource} onRemoveSecret={actions.removeSecret} /></section>
      <section id="application-panel-backup" role="region" aria-labelledby="application-nav-backup" hidden={visibleTab !== "backup"}><BackupPage source={applicationSource} backup={backup} onBusyChange={setBackupBusy} /></section>
      {activeRuntimeRepair && (
        <section id="application-panel-system" role="region" aria-labelledby="application-nav-system" hidden={visibleTab !== "system"}>
          <SystemIssuePage issue={activeRuntimeRepair} actions={actions} />
        </section>
      )}
      <section id="application-panel-settings" role="region" aria-labelledby="application-nav-settings" hidden={visibleTab !== "settings"}>
        <div hidden={settingsSection !== "general"}>
          <GeneralPage source={applicationSource} applicationPreferences={applicationPreferences} onApplicationPreferencesChange={setApplicationPreferences} reduceMotion={reduceMotion} onReduceMotionChange={setReduceMotion} />
        </div>
        <div hidden={settingsSection !== "notifications"}><NotificationsPage /></div>
      </section>
    </ApplicationShell>
  )
}
