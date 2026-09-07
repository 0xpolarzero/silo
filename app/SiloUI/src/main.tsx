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

const desktop = isTauri()
const statusPanel = desktop && getCurrentWindow().label === 'status'
const source = applicationSourceForScenario(scenarioFromSearch(window.location.search))
const store = desktop
  ? createDesktopSettingsStore(settingsForFixture(source), !statusPanel, hasSettingsFixture(window.location.search))
  : createFixtureSettingsStore(source)

async function start() {
  const stopLifecycle = desktop ? await connectSettingsLifecycle(store, !statusPanel) : () => {}
  if (desktop && !statusPanel) await invoke('initialize_settings', { fixture: hasSettingsFixture(window.location.search) })
  await store.initialize()
  const stopTheme = initializeTheme(store)
  if (import.meta.hot) import.meta.hot.dispose(() => { stopTheme(); stopLifecycle(); store.dispose() })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SettingsProvider store={store}>
        {statusPanel ? <DesktopStatusFixture /> : <FixtureApp />}
      </SettingsProvider>
    </StrictMode>,
  )
}

void start()
