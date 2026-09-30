import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "../index.css"
import { initializeTheme } from "@/features/preferences/theme"
import { applicationSourceForScenario } from "./application-scenarios"
import { FixtureApp } from "./fixture-app"
import { scenarioFromSearch } from "./scenarios"
import { createFixtureSettingsStore } from "./settings"

// Development-only entry for `npm run dev` at /preview.html. It renders
// deterministic fixtures, never Silo services, and honours the URL's `view`,
// `scenario` and fixture selectors (see UI-PATTERNS.md). `vite build` bundles
// only index.html, so nothing here reaches the production app.
const search = window.location.search
const settings = createFixtureSettingsStore(applicationSourceForScenario(scenarioFromSearch(search)))
const appearance = new URLSearchParams(search).get("appearance")
if (appearance === "dark" || appearance === "light") void settings.updateSettings({ theme: appearance })
const stopTheme = initializeTheme(settings)
if (import.meta.hot) import.meta.hot.dispose(() => { stopTheme(); settings.dispose() })

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FixtureApp settingsStore={settings} />
  </StrictMode>,
)
