import type { ApplicationSource } from "@/features/application/model/application-source"
import { createMemorySettingsStore } from "@/features/preferences/settings-store"
import type { SettingsPatch } from "@/features/preferences/model/settings"

export function settingsForFixture(source: ApplicationSource): SettingsPatch {
  const startup = source.workspaces.find(({ machine }) => machine.name === "dev") ?? source.workspaces[0]
  return { ...source.preferences, startupWorkspaceIds: source.preferences.startupWorkspaceIds ?? (startup ? [startup.machine.id] : []) }
}

export function createFixtureSettingsStore(source: ApplicationSource) {
  const store = createMemorySettingsStore()
  store.updateDefaults(settingsForFixture(source))
  return store
}

// View is navigation; the other selectors explicitly choose simulated scenarios.
export function hasSettingsFixture(search: string) {
  const parameters = new URLSearchParams(search)
  return [...parameters.keys()].some((key) => key !== "view" && key !== "native-status")
}
