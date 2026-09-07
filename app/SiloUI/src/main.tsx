import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { FixtureApp } from './fixtures/fixture-app'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { DesktopStatusFixture } from './fixtures/desktop-fixtures'
import { initializeTheme } from './features/preferences/theme'
import { SettingsProvider } from './features/preferences/settings-store'
import { createDesktopSettingsStore, connectSettingsLifecycle } from './desktop/settings'
import { createFixtureSettingsStore, hasSettingsFixture, settingsForFixture } from './fixtures/settings'
import { applicationSourceForScenario } from './fixtures/application-scenarios'
import { scenarioFromSearch } from './fixtures/scenarios'
import { ApplicationCatalogProvider } from './features/preferences/application-catalog'
import { createApplicationService, emptyApplicationCatalog } from './desktop/applications'
import { fixtureApplicationCatalog } from './fixtures/application-catalog'
import { connectSystemIntegrationLifecycle, createSystemIntegrationStoreForRuntime } from './desktop/system-integrations'
import { SystemIntegrationProvider } from './features/preferences/system-integrations-store'

const desktop = isTauri()
const statusPanel = desktop && getCurrentWindow().label === 'status'
const settingsFixture = hasSettingsFixture(window.location.search)
const source = applicationSourceForScenario(scenarioFromSearch(window.location.search))
const store = desktop
  ? createDesktopSettingsStore(settingsForFixture(source), !statusPanel, settingsFixture)
  : createFixtureSettingsStore(source)

async function start() {
  const stopLifecycle = desktop ? await connectSettingsLifecycle(store, !statusPanel) : () => {}
  if (desktop && !statusPanel) await invoke('initialize_settings', { fixture: settingsFixture })
  await store.initialize()
  const fixtureStorage = desktop && !statusPanel
    ? await invoke<boolean>('system_integrations_fixture')
    : true
  const systemIntegrations = createSystemIntegrationStoreForRuntime(store, {
    desktop,
    main: !statusPanel,
    fixtureStorage,
  })
  await systemIntegrations.initialize()
  const stopSystemLifecycle = desktop && !statusPanel && !fixtureStorage
    ? connectSystemIntegrationLifecycle(systemIntegrations)
    : () => {}
  const nativeOnboardingComplete = desktop && !statusPanel && !fixtureStorage
    ? await invoke<boolean>('debug_onboarding_complete')
    : false
  const applicationService = desktop && !settingsFixture ? createApplicationService(store) : undefined
  const applicationCatalog = applicationService
    ? await applicationService.read().catch((error: unknown) => { console.error('Silo applications:', error); return emptyApplicationCatalog })
    : fixtureApplicationCatalog
  const stopTheme = initializeTheme(store)
  if (import.meta.hot) import.meta.hot.dispose(() => { stopTheme(); stopLifecycle(); stopSystemLifecycle(); systemIntegrations.dispose(); store.dispose() })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SettingsProvider store={store}>
        <SystemIntegrationProvider store={systemIntegrations}>
          <ApplicationCatalogProvider initialCatalog={applicationCatalog} service={applicationService}>
          {statusPanel ? <DesktopStatusFixture /> : <FixtureApp nativeOnboardingComplete={nativeOnboardingComplete} />}
          </ApplicationCatalogProvider>
        </SystemIntegrationProvider>
      </SettingsProvider>
    </StrictMode>,
  )
}

void start()
