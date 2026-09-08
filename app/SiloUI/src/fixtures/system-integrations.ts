import type { SettingsStore } from "@/features/preferences/settings-store"
import { createSystemIntegrationStore, type SystemIntegrationService, type SystemIntegrations } from "@/features/preferences/system-integrations-store"

export function createFixtureSystemIntegrationStore(settings: SettingsStore) {
  const preferences = settings.getSnapshot().settings
  let current: SystemIntegrations = {
    platform: "macos",
    loginItem: { state: preferences.launchAtLogin ? "enabled" : "notRegistered", error: null },
    notifications: { state: preferences.notificationsEnabled ? "authorized" : "notDetermined", error: null },
  }
  const service: SystemIntegrationService = {
    read: async () => current,
    setLoginItem: async (enabled) => (current = { ...current, loginItem: { state: enabled ? "enabled" : "notRegistered", error: null } }).loginItem,
    requestNotifications: async () => (current = { ...current, notifications: { state: "authorized", error: null } }).notifications,
    openSettings: async () => {},
    showError: async () => {},
  }
  return createSystemIntegrationStore(service, settings, current)
}
