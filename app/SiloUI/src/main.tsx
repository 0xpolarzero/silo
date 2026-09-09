import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"

import "./index.css"
import { createApplicationService, emptyApplicationCatalog } from "@/desktop/applications"
import { createNativeDependencyStore } from "@/desktop/dependencies"
import { ProductionSurface, Unavailable } from "@/desktop/production-surface"
import { createProductionSource } from "@/desktop/production-source"
import { createDesktopSettingsStore, connectSettingsLifecycle } from "@/desktop/settings"
import { connectSystemIntegrationLifecycle, createDesktopSystemIntegrationStore } from "@/desktop/system-integrations"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { initializeTheme } from "@/features/preferences/theme"

const desktop = isTauri()
const statusPanel = desktop && getCurrentWindow().label === "status"
document.documentElement.classList.toggle("native-status", statusPanel)
const settings = createDesktopSettingsStore({}, !statusPanel)
const production = createProductionSource()

async function start() {
  if (!desktop) {
    createRoot(document.getElementById("root")!).render(<Unavailable message="Open Silo in the desktop app." />)
    return
  }

  const dependencies = !statusPanel ? createNativeDependencyStore() : null
  dependencies?.retry()
  const stopSettingsLifecycle = await connectSettingsLifecycle(settings, !statusPanel, () => production.drainSetup())
  if (!statusPanel) await invoke("initialize_settings")
  await settings.initialize()
  await production.loadConfiguration()
  const systemIntegrations = createDesktopSystemIntegrationStore(settings)
  if (!statusPanel) await systemIntegrations.initialize()
  const stopSystemLifecycle = !statusPanel ? connectSystemIntegrationLifecycle(systemIntegrations) : () => {}
  const applicationService = !statusPanel ? createApplicationService(settings) : undefined
  const applicationCatalog = applicationService
    ? await applicationService.read().catch((error: unknown) => { console.error("Silo applications:", error); return emptyApplicationCatalog })
    : emptyApplicationCatalog
  const stopTheme = initializeTheme(settings)
  void production.initialize().catch((error: unknown) => console.error("Silo live updates:", error))

  if (import.meta.hot) import.meta.hot.dispose(() => {
    dependencies?.dispose()
    production.dispose()
    stopTheme()
    stopSettingsLifecycle()
    stopSystemLifecycle()
    systemIntegrations.dispose()
    settings.dispose()
  })

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <SettingsProvider store={settings}>
        <SystemIntegrationProvider store={systemIntegrations}>
          <ApplicationCatalogProvider initialCatalog={applicationCatalog} service={applicationService}>
            <ProductionSurface source={production} dependencyStore={dependencies} statusPanel={statusPanel} />
          </ApplicationCatalogProvider>
        </SystemIntegrationProvider>
      </SettingsProvider>
    </StrictMode>,
  )
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  createRoot(document.getElementById("root")!).render(<Unavailable message={`Silo startup failed: ${message}. No sandbox state changed.`} />)
})
