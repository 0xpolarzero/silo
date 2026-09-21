import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApplicationCommandMenu } from '@/features/application/components/application-command-menu';
import { applicationCommands } from '@/features/application/components/application-commands';
import { ApplicationShell } from '@/features/application/components/application-shell';
import { useApplicationNavigation } from '@/features/application/model/use-application-navigation';
import { createDirectoryStore } from '@/features/application/model/directory-store';
import { OverviewPage } from '@/features/application/pages/overview-page';
import { WorkspacesPage } from '@/features/application/pages/workspaces-page';
import { GitHubPage } from '@/features/application/pages/github-page';
import { SecretsPage } from '@/features/application/pages/secrets-page';
import { BackupPage } from '@/features/application/pages/backup-page';
import { GeneralPage } from '@/features/application/pages/general-page';
import { NotificationsPage } from '@/features/application/pages/notifications-page';
import { RemoteComputersSettings } from '@/features/application/components/remote-computers-settings';
import { SettingsProvider, createMemorySettingsStore } from '@/features/preferences/settings-store';
import { ApplicationCatalogProvider } from '@/features/preferences/application-catalog';
import { SystemIntegrationProvider } from '@/features/preferences/system-integrations-store';
import { fixtureApplicationCatalog } from '@/fixtures/application-catalog';
import { createFixtureSystemIntegrationStore } from '@/fixtures/system-integrations';
import { demoActions, demoBackup, demoSource, readOnlyOperation } from './data';

function preventInteraction(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

export function ReadOnlyDemo() {
  const [settings] = useState(() => createMemorySettingsStore(demoSource.preferences));
  const [integrations] = useState(() => createFixtureSystemIntegrationStore(settings));
  return <SettingsProvider store={settings}>
    <SystemIntegrationProvider store={integrations}>
      <ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}>
        <DemoPages />
      </ApplicationCatalogProvider>
    </SystemIntegrationProvider>
  </SettingsProvider>;
}

function DemoPages() {
  const navigation = useApplicationNavigation(false);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<Set<string>>(new Set());
  const commands = applicationCommands(demoSource, demoActions, route => {
    setSelectedWorkspaceIds(new Set(route.workspace ? [route.workspace] : []));
    if (route.workspaceSection) navigation.selectWorkspaceSection(route.workspaceSection);
    else if (route.settingsSection) navigation.selectSettingsSection(route.settingsSection);
    else if (route.tab) navigation.selectTab(route.tab);
  }).filter(command => command.group !== 'Actions');
  const [directoryStore] = useState(() => createDirectoryStore(demoActions.listWorkspaceDirectory));
  const overview = navigation.tab === 'workspaces' && navigation.workspaceSection === 'overview';
  let page: ReactNode;
  if (navigation.tab === 'workspaces') {
    page = navigation.workspaceSection === 'overview'
      ? <OverviewPage readOnly source={demoSource} actions={demoActions} onMachinesChange={readOnlyOperation} />
      : <WorkspacesPage
          section={navigation.workspaceSection} onSectionChange={navigation.selectWorkspaceSection}
          workspaces={demoSource.workspaces} activities={demoSource.activities}
          network={demoSource.network} networkActions={demoActions}
          editor={demoSource.preferences.editor} browser={demoSource.preferences.browser}
          directoryStore={directoryStore} active selectedWorkspaceIds={selectedWorkspaceIds}
          logQuery="" repositoryPushOperations={[]}
          onOpenEditor={readOnlyOperation} onWorkspaceFilterChange={readOnlyOperation}
          onLogQueryChange={readOnlyOperation} onPushRepository={readOnlyOperation}
          onDismissRepositoryPush={readOnlyOperation}
        />;
  } else if (navigation.tab === 'github') {
    page = <GitHubPage source={demoSource} actions={demoActions} />;
  } else if (navigation.tab === 'secrets') {
    page = <SecretsPage source={demoSource} onSaveSecret={readOnlyOperation} onRemoveSecret={readOnlyOperation} />;
  } else if (navigation.tab === 'backup') {
    page = <BackupPage source={demoSource} backup={demoBackup} />;
  } else if (navigation.settingsSection === 'computers') {
    page = <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-6"><RemoteComputersSettings source={demoSource} actions={demoActions} /></div>;
  } else if (navigation.settingsSection === 'notifications') {
    page = <NotificationsPage />;
  } else {
    page = <GeneralPage source={demoSource} applicationPreferences={demoSource.preferences}
      onApplicationPreferencesChange={readOnlyOperation} reduceMotion onReduceMotionChange={readOnlyOperation} />;
  }
  return <div className="demo-app">
    <ApplicationShell
      activeTab={navigation.tab} workspaceSection={navigation.workspaceSection}
      settingsSection={navigation.settingsSection} systemIssueStatus={null}
      workspaceAttention={{ errors: 0, warnings: 0 }}
      defaultSettingsMenuOpen
      onTabChange={navigation.selectTab} onWorkspaceSectionChange={navigation.selectWorkspaceSection}
      onSettingsSectionChange={navigation.selectSettingsSection}
      canGoBack={navigation.canGoBack} canGoForward={navigation.canGoForward}
      onGoBack={navigation.goBack} onGoForward={navigation.goForward}
      commandMenu={<ApplicationCommandMenu commands={commands} />}
    >
      <fieldset disabled={!overview} aria-label="Read-only sample data" className="demo-readonly"
        onClickCapture={overview ? undefined : preventInteraction} onSubmitCapture={preventInteraction}
        onPointerDownCapture={overview ? undefined : event => event.stopPropagation()}
        onMouseDownCapture={overview ? undefined : event => event.stopPropagation()}
        onDragStartCapture={preventInteraction} onDropCapture={preventInteraction}
        onKeyDownCapture={event => { if (!overview && (event.key === 'Enter' || event.key === ' ')) preventInteraction(event); }}>
        {page}
      </fieldset>
    </ApplicationShell>
  </div>;
}
