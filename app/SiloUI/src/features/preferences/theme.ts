import { useSettings, type SettingsStore } from "./settings-store"
import type { Settings } from "./model/settings"

export type Theme = Settings["theme"]

export function useTheme() {
  const { settings, updateSettings } = useSettings()
  return { theme: settings.theme, setTheme: (theme: string) => { void updateSettings({ theme: theme as Theme }) } }
}

// Initialize before React renders, in both the main window and the status panel.
export function initializeTheme(store: SettingsStore) {
  const system = window.matchMedia("(prefers-color-scheme: dark)")
  function apply() {
    const { theme } = store.getSnapshot().settings
    document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && system.matches))
  }
  apply()
  const unsubscribe = store.subscribe(apply)
  system.addEventListener("change", apply)
  return () => {
    unsubscribe()
    system.removeEventListener("change", apply)
  }
}
