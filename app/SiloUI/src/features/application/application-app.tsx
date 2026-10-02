import { workspaceTarget } from "./model/remote-computers"
import { useBackendNotices } from "@/features/application/model/use-backend-notices"
import { useUpdates } from "@/features/updates/update-store"
import { updateCommands } from "@/features/updates/update-commands"
import { useAppMenu } from "@/desktop/app-menu"
import { UpdateNotice } from "@/features/updates/updates"
import { createDirectoryStore } from "@/features/application/model/directory-store"
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"

import type { BackupController } from "@/features/application/model/backup-source"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { ApplicationShell, type ApplicationNavigationLoading } from "@/features/application/components/application-shell"
import { MachineEditorDraftsProvider } from "@/features/sandboxes/model/editor-drafts"
import { ApplicationCommandMenu } from "@/features/application/components/application-command-menu"
import { OperationQueueToast } from "@/features/application/components/operation-queue-panel"
import { QuitRequestConfirmation, type ConnectQuitConfirmation } from "@/features/application/components/quit-request-confirmation"
import { applicationCommands, type SandboxCommandRequest } from "@/features/application/components/application-commands"
import type { ApplicationActions, ApplicationSource, RepositoryPushOperation, RepositoryPushTarget, SandboxConfigurationOperation } from "@/features/application/model/application-source"
import { useApplicationNavigation, type ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { defaultStartupWorkspaceIds } from "@/features/application/model/startup-workspaces"
import { AlphaNotice } from "@/features/application/components/alpha-notice"
import { EditorIncludeNotice } from "@/features/application/components/editor-include-notice"
import { RemoteComputersSettings } from "@/features/application/components/remote-computers-settings"
import { GeneralPage } from "@/features/application/pages/general-page"
import { GitHubPage } from "@/features/application/pages/github-page"
import { NotificationsPage } from "@/features/application/pages/notifications-page"
import { OverviewPage, type SandboxPageRequest } from "@/features/application/pages/overview-page"
import { useSandboxTransfer } from "@/features/application/components/sandbox-transfer"
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
  const githubSourceBusy = source.github.state === "connecting"
    || (source.github.workspaceOperations ?? []).some(({ status }) => status === "applying")

  return {
    tabs: {
      github: githubBusy || githubSourceBusy || runningCategories.has("github"),
      secrets: runningCategories.has("secrets"),
      system: source.runtimeRepair?.checking || runningCategories.has("system"),
    },
    workspaceSections: {
      overview: source.sandboxConfigurationOperation?.status === "applying"
        || source.workspaces.some(({ state }) => state === "starting")
        || backupBusy
        || runningCategories.has("sandbox")
        || runningCategories.has("backup"),
      files: source.repositoryPushOperations.some(({ status }) => status === "pushing")
        || runningCategories.has("git"),
    },
  }
}

// Request tokens only need to be unique: each one is consumed once by the page it opens.
let requestTokens = 0
const nextRequestToken = () => ++requestTokens

type ApplicationAppProps = {
  source: ApplicationSource
  actions: ApplicationActions
  backup: BackupController
  initialRoute?: ApplicationInitialRoute
  routeRequest?: ApplicationInitialRoute
  /** The desktop main window's Quit confirmation hook-up (`connectQuitConfirmation`). */
  connectQuitConfirmation?: ConnectQuitConfirmation
}

export function ApplicationApp(props: ApplicationAppProps) {
  return <SettingsProvider initialSettings={{
    ...props.source.preferences,
    startupWorkspaceIds: props.source.preferences.startupWorkspaceIds ?? defaultStartupWorkspaceIds(props.source.workspaces),
  }}><ApplicationContent {...props} /></SettingsProvider>
}

function ApplicationContent({ source, actions, backup, initialRoute, routeRequest, connectQuitConfirmation }: ApplicationAppProps) {
  useBackendNotices()
  const updates = useUpdates()
  const installingUpdate = updates?.snapshot?.phase === "installing"
    || Boolean(updates?.pending && (updates.snapshot?.phase === "ready" || updates.snapshot?.retryAction === "install"))
  const [newSandboxRequest, setNewSandboxRequest] = useState(0)
  // A palette command that opens something on a sandbox's page (folder picker, Fork, Delete).
  const [sandboxRequest, setSandboxRequest] = useState<SandboxPageRequest>()
  const [searchRequest, setSearchRequest] = useState(0)
  const [sidebarRequest, setSidebarRequest] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [directoryStore] = useState(() => createDirectoryStore(actions.listWorkspaceDirectory))
  useLayoutEffect(() => {
    directoryStore.setLoader(actions.listWorkspaceDirectory)
  }, [actions.listWorkspaceDirectory, directoryStore])
  const previousFileStates = useRef(new Map<string, string>())
  useLayoutEffect(() => {
    const current = new Map(source.workspaces.map((workspace) => [
      workspaceTarget(workspace), `${workspace.machine.id}:${workspace.state}:${workspace.freshness}`,
    ]))
    for (const [name, state] of previousFileStates.current) {
      if (current.get(name) !== state) directoryStore.invalidateWorkspace(name)
    }
    previousFileStates.current = current
  }, [source.workspaces, directoryStore])

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
  const activeRuntimeRepair = source.runtimeRepair
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
  const backupBusy = backup.state.operation?.kind === "running"
  const [githubBusy, setGitHubBusy] = useState(
    source.github.state === "connecting"
      || (source.github.workspaceOperations ?? []).some(({ status }) => status === "applying"),
  )
  const visibleTab = activeTab
  const visibleWorkspaceSection = workspaceSection
  const applicationSource = {
    ...source,
    workspaces,
    sandboxConfigurationOperation,
    repositoryPushOperations,
    preferences: { ...source.preferences, ...settings },
  }
  const transfer = useSandboxTransfer(backup, { source: applicationSource, openSandbox: (id) => navigation.openSandbox(id) })

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setSelectedWorkspaceIds((current) => {
      const availableIds = new Set(source.workspaces.map(({ machine }) => machine.id))
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [source.workspaces])

  // The latest native snapshot, for saves that settle after later snapshots arrived.
  const latestSource = useRef(source)
  useLayoutEffect(() => { latestSource.current = source }, [source])

  // Each optimistic state yields only to its own authoritative field, so a configuration
  // snapshot never discards a push in flight, or the reverse.
  useEffect(() => {
    // The native bridge clears or replaces the pending operation alongside its authoritative snapshot.
    // oxlint-disable-next-line react/set-state-in-effect
    setSandboxConfigurationOperation(source.sandboxConfigurationOperation)
  }, [source.sandboxConfigurationOperation])
  useEffect(() => {
    // The native bridge replaces local push progress with its authoritative operation result.
    // oxlint-disable-next-line react/set-state-in-effect
    setRepositoryPushOperations(source.repositoryPushOperations)
  }, [source.repositoryPushOperations])

  function changeApplicationPreferences(next: ApplicationPreferenceSelection) {
    void updateSettings(applicationPreferenceChanges(applicationPreferences, next))
  }

  function updateMachines(machines: SetupMachineConfiguration[], baseline?: SetupMachineConfiguration[]) {
    const candidate = { schemaVersion: 1 as const, machines }
    setSandboxConfigurationOperation({
      id: "local-sandbox-configuration",
      status: "applying",
      candidate,
      progressEvents: [],
      result: null,
      error: null,
    })
    const outcome = actions.saveMachineConfiguration(candidate, baseline)
    // Without a promise, only the next snapshot reports the change; keep the optimistic state until then.
    if (!outcome || typeof outcome.then !== "function") return Promise.resolve()
    // Once the save settles the native snapshot is authoritative: adopt the latest one. A no-op
    // save publishes nothing, and a late stale-baseline rejection must not restore the operation
    // from when the save began. Re-raise a rejection so the editor can react.
    const settle = () => setSandboxConfigurationOperation(latestSource.current.sandboxConfigurationOperation)
    return outcome.then(settle, (cause: unknown) => {
      settle()
      throw cause
    })
  }

  function pushRepository(workspace: string, repositoryPath: string, commitCount: number, target: RepositoryPushTarget) {
    setRepositoryPushOperations((current) => [
      ...current.filter((operation) => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath),
      { workspace, repositoryPath, commitCount, target, status: "pushing" },
    ])
    actions.pushRepository(workspace, repositoryPath, target)
  }

  const dismissRepositoryPush = useCallback((workspace: string, repositoryPath: string) => {
    if (actions.dismissRepositoryPush) { actions.dismissRepositoryPush(workspace, repositoryPath); return }
    setRepositoryPushOperations((current) => current.filter((operation) => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath))
  }, [actions])

  function resolveSandboxId(value: string) {
    return source.workspaces.find((workspace) => workspace.machine.id === value || workspace.machine.name === value || workspaceTarget(workspace) === value)?.machine.id ?? value
  }

  // History never keeps a page for a sandbox that no longer exists (deleted, or gone after a
  // refresh): its entries become the Sandboxes list in place, so Back cannot land on it.
  const { forgetSandboxes } = navigation
  useEffect(() => {
    const known = new Set<string>()
    for (const workspace of source.workspaces) known.add(workspace.machine.id).add(workspace.machine.name).add(workspaceTarget(workspace))
    for (const machine of sandboxConfigurationOperation?.candidate.machines ?? []) known.add(machine.id).add(machine.name)
    forgetSandboxes((workspace) => known.has(workspace))
  }, [source.workspaces, sandboxConfigurationOperation, forgetSandboxes])

  function navigateCommand(route: ApplicationInitialRoute) {
    const wantsSection = Boolean(route.workspaceSection && route.workspaceSection !== "overview")
    // A workspace without a detail section deep-links into that sandbox's overview page.
    if (route.workspace && !wantsSection) { navigation.openSandbox(resolveSandboxId(route.workspace), route.sandboxTab); return }
    if (route.workspace || wantsSection) {
      setSelectedWorkspaceIds(new Set(source.workspaces
        .filter(({ machine }) => machine.id === route.workspace || machine.name === route.workspace)
        .map(({ machine }) => machine.id)))
    }
    if (route.workspaceSection || route.workspace) navigation.selectWorkspaceSection(route.workspaceSection ?? "overview")
    else if (route.settingsSection) navigation.selectSettingsSection(route.settingsSection)
    else if (route.tab) navigation.selectTab(route.tab)
  }

  const navigateRequested = useEffectEvent(navigateCommand)
  useEffect(() => {
    // Apply an external status-panel navigation request to the existing window.
    // oxlint-disable-next-line react/set-state-in-effect
    if (routeRequest) navigateRequested(routeRequest)
  }, [routeRequest])

  const canCreateSandbox = sandboxConfigurationOperation === null
  const canImport = !backupBusy
  const canCheckUpdates = Boolean(updates && !updates.pending && !["checking", "downloading", "installing"].includes(updates.snapshot?.phase ?? ""))
  function requestNewSandbox() {
    navigation.selectWorkspaceSection("overview")
    setNewSandboxRequest(nextRequestToken())
  }
  function requestOnSandboxPage(workspaceId: string, request: SandboxCommandRequest) {
    navigation.openSandbox(workspaceId)
    setSandboxRequest({ token: nextRequestToken(), workspaceId, request })
  }

  // The review popover anchors to the sandbox list's Add button, so show the list first.
  const openImport = () => { navigation.selectWorkspaceSection("overview"); navigation.closeSandbox(); void transfer.beginImport() }
  const nativeMenu = useAppMenu({ ready: true, busy: installingUpdate,
    canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward,
    canCreateSandbox, canImport, canCheckUpdates, sidebarCollapsed,
  }, (command) => {
    if (installingUpdate) return
    switch (command) {
      case "settings": navigation.selectSettingsSection("general"); break
      case "check-updates":
        navigation.selectSettingsSection("general")
        if (canCheckUpdates) updates?.check()
        break
      case "new-sandbox":
        if (canCreateSandbox) requestNewSandbox()
        break
      case "import-sandbox":
        if (canImport) openImport()
        break
      case "search": setSearchRequest(value => value + 1); break
      case "toggle-sidebar": setSidebarRequest(value => value + 1); break
      case "go-back": navigation.goBack(); break
      case "go-forward": navigation.goForward(); break
      case "go-sandboxes": navigation.selectWorkspaceSection("overview"); break
      case "go-files": navigation.selectWorkspaceSection("files"); break
      case "go-logs": navigation.selectWorkspaceSection("logs"); break
      case "go-network": navigation.selectWorkspaceSection("network"); break
      case "go-activity": navigation.selectWorkspaceSection("activity"); break
      case "go-github": navigation.selectTab("github"); break
      case "go-secrets": navigation.selectTab("secrets"); break
    }
  })

  return (
    // Keeps unsaved sandbox edits while navigating between sections (I-37).
    <MachineEditorDraftsProvider>
    <ApplicationShell
      toggleSidebarRequest={sidebarRequest}
      onSidebarCollapsedChange={setSidebarCollapsed}
      navigationDisabled={installingUpdate}
      notice={<UpdateNotice onOpen={() => navigation.selectSettingsSection("general")} />}
      banner={<><AlphaNotice /><EditorIncludeNotice /></>}
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
      commandMenu={<ApplicationCommandMenu nativeShortcuts={nativeMenu} openRequest={searchRequest} disabled={installingUpdate} commands={[...applicationCommands(applicationSource, actions, navigateCommand, {
        onImportSandbox: canImport ? openImport : undefined,
        onNewSandbox: canCreateSandbox ? requestNewSandbox : undefined,
        onExportSandbox: canImport ? (name) => { void transfer.exportSandbox(name) } : undefined,
        onSandboxRequest: requestOnSandboxPage,
      }), ...updateCommands(updates, () => navigation.selectSettingsSection("general"))]} />}
    >
      {/* One toast reflects VM-changing operations wherever the user is, so progress and
          Cancel never vanish while the work continues. It renders nothing inline. */}
      <OperationQueueToast queue={source.operationQueue} onCancel={actions.cancelOperation} />
      <QuitRequestConfirmation connect={connectQuitConfirmation} />
      <section id="application-panel-workspaces" role="region" aria-labelledby="application-nav-workspaces" hidden={visibleTab !== "workspaces"} className="h-full min-h-0 overflow-hidden">
        {visibleWorkspaceSection === "overview" ? (
          <OverviewPage active={visibleTab === "workspaces"} newSandboxRequest={newSandboxRequest} onNewSandboxRequestHandled={(id) => setNewSandboxRequest(current => current === id ? 0 : current)}
            sandboxRequest={sandboxRequest} onSandboxRequestHandled={(token) => setSandboxRequest(current => current?.token === token ? undefined : current)} onExportSandbox={transfer.exportSandbox} onImportSandbox={openImport} importPopover={transfer.importPopover} backup={backup} source={applicationSource}
            selectedSandboxId={navigation.workspace ? resolveSandboxId(navigation.workspace) : null}
            sandboxTab={navigation.sandboxTab}
            onOpenSandbox={(id, tab) => navigation.openSandbox(id, tab)}
            onCloseSandbox={() => navigation.closeSandbox()}
            onSelectSandboxTab={(tab) => navigation.selectSandboxTab(tab)}
            onNavigate={navigateCommand}
            actions={{ ...actions, dismissMachineConfigurationError: () => {
            if (sandboxConfigurationOperation?.status !== "failed") return
            actions.dismissMachineConfigurationError()
            setSandboxConfigurationOperation(null)
          } }} onMachinesChange={updateMachines} />
        ) : (
          <WorkspacesPage
            source={applicationSource}
            onSectionChange={navigation.selectWorkspaceSection}
            network={source.network}
            networkError={source.networkError}
            networkActions={actions}
            onOpenEditor={actions.openEditor}
            editor={applicationPreferences.editor}
            directoryStore={directoryStore}
            active={visibleTab === "workspaces"}
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
            operationQueue={source.operationQueue}
            onDismissRepositoryPush={dismissRepositoryPush}
            onCreateSandbox={canCreateSandbox && !installingUpdate ? requestNewSandbox : undefined}
          />
        )}
      </section>
      <section id="application-panel-github" role="region" aria-labelledby="application-nav-github" hidden={visibleTab !== "github"} className="h-full min-h-0 overflow-hidden">
        <GitHubPage source={applicationSource} actions={actions} onBusyChange={setGitHubBusy} />
      </section>
      <section id="application-panel-secrets" role="region" aria-labelledby="application-nav-secrets" hidden={visibleTab !== "secrets"}><SecretsPage source={applicationSource} onSaveSecret={actions.saveSecret} onRemoveSecret={actions.removeSecret} onRetrySecret={actions.retrySecret} /></section>
      {activeRuntimeRepair && (
        <section id="application-panel-system" role="region" aria-labelledby="application-nav-system" hidden={visibleTab !== "system"}>
          <SystemIssuePage issue={activeRuntimeRepair} actions={actions} />
        </section>
      )}
      <section id="application-panel-settings" role="region" aria-labelledby="application-nav-settings" hidden={visibleTab !== "settings"}>
        <div hidden={settingsSection !== "general"}>
          <GeneralPage source={source} applicationPreferences={applicationPreferences} onApplicationPreferencesChange={changeApplicationPreferences} reduceMotion={reduceMotion} onReduceMotionChange={(enabled) => { void updateSettings({ reduceMotion: enabled }) }} />
        </div>
        <div hidden={settingsSection !== "computers"} className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-6"><RemoteComputersSettings source={source} actions={actions} active={visibleTab === "settings" && settingsSection === "computers"} /></div>
        <div hidden={settingsSection !== "notifications"}><NotificationsPage /></div>
      </section>
    </ApplicationShell>
    </MachineEditorDraftsProvider>
  )
}
