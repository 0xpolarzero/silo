import { invoke } from "@tauri-apps/api/core"

import {
  createFixtureSystemIntegrationStore,
  createSystemIntegrationStore,
  systemIntegrationsSchema,
  type LoginItemStatus,
  type NotificationStatus,
  type SystemIntegrationService,
} from "@/features/preferences/system-integrations-store"
import type { SettingsStore } from "@/features/preferences/settings-store"

export function createDesktopSystemIntegrationStore(settings: SettingsStore) {
  const service: SystemIntegrationService = {
    read: async () => systemIntegrationsSchema.parse(await invoke("read_system_integrations")),
    setLoginItem: (enabled) => invoke<LoginItemStatus>("set_login_item", { enabled }),
    requestNotifications: () => invoke<NotificationStatus>("request_notification_authorization"),
    openSettings: (integration) => invoke("open_integration_settings", { integration }),
    showError: (message) => invoke("show_integration_error", { message }),
  }
  return createSystemIntegrationStore(service, settings)
}

export function createSystemIntegrationStoreForRuntime(
  settings: SettingsStore,
  runtime: { desktop: boolean; main: boolean; fixtureStorage: boolean },
) {
  return runtime.desktop && runtime.main && !runtime.fixtureStorage
    ? createDesktopSystemIntegrationStore(settings)
    : createFixtureSystemIntegrationStore(settings)
}

export function connectSystemIntegrationLifecycle(store: ReturnType<typeof createDesktopSystemIntegrationStore>) {
  const refresh = () => { void store.refresh() }
  window.addEventListener("focus", refresh)
  return () => window.removeEventListener("focus", refresh)
}
