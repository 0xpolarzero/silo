import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApplicationCommandMenu } from '@/features/application/components/application-command-menu';
import { applicationCommands } from '@/features/application/components/application-commands';
import { ApplicationShell } from '@/features/application/components/application-shell';
import { useApplicationNavigation } from '@/features/application/model/use-application-navigation';
import { createDirectoryStore } from '@/features/application/model/directory-store';
import { OverviewPage } from '@/features/application/pages/overview-page';
import { ComputersPage } from '@/features/application/pages/computers-page';
import { GitHubPage } from '@/features/application/pages/github-page';
import { SecretsPage } from '@/features/application/pages/secrets-page';
import { GeneralPage } from '@/features/application/pages/general-page';
import { NotificationsPage } from '@/features/application/pages/notifications-page';
import { ConnectionsSettings } from '@/features/application/components/connections-settings';
import { SettingsProvider, createMemorySettingsStore } from '@/features/preferences/settings-store';
import { ApplicationCatalogProvider } from '@/features/preferences/application-catalog';
import { SystemIntegrationProvider } from '@/features/preferences/system-integrations-store';
import { fixtureApplicationCatalog } from '@/fixtures/application-catalog';
import { useBackupFixture } from '@/fixtures/application-backup';
import { createFixtureSystemIntegrationStore } from '@/fixtures/system-integrations';
import { demoActions, demoSource, readOnlyOperation } from './data';

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
  const [selectedComputerIds, setSelectedComputerIds] = useState<Set<string>>(new Set());
  const commands = applicationCommands(demoSource, demoActions, route => {
    setSelectedComputerIds(new Set(route.computer ? [route.computer] : []));
    if (route.computerSection) navigation.selectComputerSection(route.computerSection);
    else if (route.settingsSection) navigation.selectSettingsSection(route.settingsSection);
    else if (route.tab) navigation.selectTab(route.tab);
  }).filter(command => command.group !== 'Actions');
  const [directoryStore] = useState(() => createDirectoryStore(demoActions.listComputerDirectory));
  const overview = navigation.tab === 'computers' && navigation.computerSection === 'overview';
  // Screenshot capture only (scripts/capture-media.mjs): shows the export entry the read-only demo omits.
  const [exportCapture] = useState(() => new URLSearchParams(location.search).get('capture') === 'export');
  const backup = useBackupFixture({ source: demoSource });
  let page: ReactNode;
  if (navigation.tab === 'computers') {
    page = navigation.computerSection === 'overview'
      ? exportCapture
        ? <OverviewPage source={demoSource} actions={demoActions} onConfigurationsChange={readOnlyOperation} backup={backup} onExportComputer={readOnlyOperation} onImportComputer={readOnlyOperation} />
        : <OverviewPage readOnly source={demoSource} actions={demoActions} onConfigurationsChange={readOnlyOperation} />
      : <ComputersPage
          source={demoSource}
          section={navigation.computerSection} onSectionChange={navigation.selectComputerSection}
          computers={demoSource.computers} activities={demoSource.activities}
          network={demoSource.network} networkActions={demoActions}
          editor={demoSource.preferences.editor} browser={demoSource.preferences.browser}
          directoryStore={directoryStore} active selectedComputerIds={selectedComputerIds}
          logQuery="" repositoryPushOperations={[]}
          onOpenEditor={readOnlyOperation} onComputerFilterChange={readOnlyOperation}
          onLogQueryChange={readOnlyOperation} onPushRepository={readOnlyOperation}
          onDismissRepositoryPush={readOnlyOperation}
        />;
  } else if (navigation.tab === 'github') {
    page = <GitHubPage source={demoSource} actions={demoActions} />;
  } else if (navigation.tab === 'secrets') {
    page = <SecretsPage source={demoSource} onSaveSecret={readOnlyOperation} onRemoveSecret={readOnlyOperation} />;
  } else if (navigation.settingsSection === 'connections') {
    page = <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-6"><ConnectionsSettings source={demoSource} actions={demoActions} /></div>;
  } else if (navigation.settingsSection === 'notifications') {
    page = <NotificationsPage />;
  } else {
    page = <GeneralPage source={demoSource} applicationPreferences={demoSource.preferences}
      onApplicationPreferencesChange={readOnlyOperation} reduceMotion onReduceMotionChange={readOnlyOperation} />;
  }
  return <div className="demo-app">
    <ApplicationShell
      activeTab={navigation.tab} computerSection={navigation.computerSection}
      settingsSection={navigation.settingsSection} systemIssueStatus={null}
      computerAttention={{ errors: 0, warnings: 0 }}
      defaultSettingsMenuOpen
      onTabChange={navigation.selectTab} onComputerSectionChange={navigation.selectComputerSection}
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
