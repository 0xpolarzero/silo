import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"

import "./index.css"
import { SiloWindow } from "@/components/silo-window"
import { createApplicationService, emptyApplicationCatalog } from "@/desktop/applications"
import { createNativeDependencyStore, useDependencyStore, type DependencyStore } from "@/desktop/dependencies"
import { ProductionOnboarding } from "@/desktop/production-onboarding"
import { createProductionSource, useProductionSource, type ProductionSource } from "@/desktop/production-source"
import { createDesktopSettingsStore, connectSettingsLifecycle } from "@/desktop/settings"
import { StatusPanel } from "@/desktop/status-panel"
import { connectSystemIntegrationLifecycle, createDesktopSystemIntegrationStore } from "@/desktop/system-integrations"
import { ApplicationApp } from "@/features/application/application-app"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { SettingsProvider, useSettings } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { initializeTheme } from "@/features/preferences/theme"

const desktop = isTauri()
const statusPanel = desktop && getCurrentWindow().label === "status"
document.documentElement.classList.toggle("native-status", statusPanel)
const settings = createDesktopSettingsStore({}, !statusPanel)
const production = createProductionSource()

// oxlint-disable-next-line react/only-export-components
function Unavailable({ message, retry }: { message: string; retry?: () => void }) {
  return <SiloWindow title="Silo" label="Silo unavailable"><div className="grid flex-1 place-items-center p-6"><div className="max-w-lg rounded-lg border border-destructive/25 bg-destructive/[.06] p-4" role="alert"><h1 className="text-sm font-semibold">Silo could not load</h1><p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{message}</p>{retry && <button type="button" className="mt-3 rounded-md border px-3 py-1.5 text-xs" onClick={retry}>Retry</button>}</div></div></SiloWindow>
}

// oxlint-disable-next-line react/only-export-components
function ProductionSurface({ source, dependencyStore }: { source: ProductionSource; dependencyStore: DependencyStore | null }) {
  const current = useProductionSource(source)
  const dependencies = useDependencyStore(dependencyStore)
  const { settings: currentSettings } = useSettings()
  if (!statusPanel && !currentSettings.onboardingComplete && dependencies) {
    return <ProductionOnboarding application={current.source} dependencies={dependencies} source={source} />
  }
  if (!current.source) {
    const message = current.error ?? (current.loading ? "Reading live sandbox state…" : "The native application state is unavailable. No sandbox state changed.")
    return <Unavailable message={message} retry={current.loading ? undefined : () => { void source.refresh() }} />
  }
  return statusPanel
    ? <StatusPanel source={current.source} actions={source.statusActions} />
    : <ApplicationApp source={current.source} actions={source.applicationActions} backup={current.backup} />
}

async function start() {
  if (!desktop) {
    createRoot(document.getElementById("root")!).render(<Unavailable message="Open Silo in the desktop app." />)
    return
  }

  const dependencies = !statusPanel ? createNativeDependencyStore() : null
  dependencies?.retry()
  const stopSettingsLifecycle = await connectSettingsLifecycle(settings, !statusPanel)
  if (!statusPanel) await invoke("initialize_settings")
  await settings.initialize()
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
            <ProductionSurface source={production} dependencyStore={dependencies} />
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
