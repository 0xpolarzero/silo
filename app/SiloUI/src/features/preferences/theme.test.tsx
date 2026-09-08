import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { GeneralPage } from "@/features/application/pages/general-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createMemorySettingsStore, createSettingsStore, SettingsProvider, type SettingsStore } from "./settings-store"
import { initializeTheme } from "./theme"
import { SystemIntegrationProvider } from "./system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

let systemDark = false
let media: EventTarget
let stopTheme: (() => void) | undefined

beforeEach(() => {
  systemDark = false
  media = new EventTarget()
  Object.defineProperty(media, "matches", { get: () => systemDark })
  vi.stubGlobal("matchMedia", vi.fn(() => media))
})

afterEach(() => {
  cleanup()
  stopTheme?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.classList.remove("dark")
})

function renderSettings(store: SettingsStore) {
  const source = applicationSourceForScenario("complete")
  const user = userEvent.setup()
  render(<SettingsProvider store={store}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(store)}><GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} /></SystemIntegrationProvider></SettingsProvider>)
  return async (theme: string) => {
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: theme }))
  }
}

function setup(store = createMemorySettingsStore()) {
  stopTheme = initializeTheme(store)
  return { select: renderSettings(store), store }
}

function changeSystem(dark: boolean) {
  act(() => { systemDark = dark; media.dispatchEvent(new Event("change")) })
}

it("follows system changes live and keeps explicit overrides until System is selected again", async () => {
  const { select, store } = setup()
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("System")
  changeSystem(true)
  expect(document.documentElement).toHaveClass("dark")
  await select("Light")
  expect(store.getSnapshot().settings.theme).toBe("light")
  changeSystem(false)
  changeSystem(true)
  expect(document.documentElement).not.toHaveClass("dark")
  await select("Dark")
  changeSystem(false)
  expect(document.documentElement).toHaveClass("dark")
  await select("System")
  expect(store.getSnapshot().settings.theme).toBe("system")
  expect(document.documentElement).not.toHaveClass("dark")
  changeSystem(true)
  expect(document.documentElement).toHaveClass("dark")
})

it("restores the saved choice before rendering", () => {
  const store = createMemorySettingsStore({ theme: "dark" })
  stopTheme = initializeTheme(store)
  expect(document.documentElement).toHaveClass("dark")
  renderSettings(store)
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark")
})

it("updates the appearance and setting when another shared consumer changes the preference", async () => {
  const { store } = setup()
  await act(async () => { await store.updateSettings({ theme: "dark" }) })
  expect(document.documentElement).toHaveClass("dark")
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark")
  await act(async () => { await store.updateSettings({ theme: "system" }) })
  expect(document.documentElement).not.toHaveClass("dark")
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("System")
})

it("still changes appearance when saving the preference is unavailable", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const store = createSettingsStore({
    read: async () => ({ revision: 0, settings: {}, onboardingDraft: null, saveError: null }),
    subscribe: async () => () => {},
    updateSettings: async () => { throw new Error("Storage unavailable") },
    updateOnboardingDraft: async () => { throw new Error("Unused") },
    flush: async () => {},
  })
  const { select } = setup(store)
  await select("Dark")
  expect(document.documentElement).toHaveClass("dark")
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark")
  expect(store.getSnapshot().settings.theme).toBe("dark")
  expect(store.getSnapshot().saveError).toBe("Storage unavailable")
})

it("stops observing settings and system changes when disposed", async () => {
  const { store } = setup()
  stopTheme?.()
  changeSystem(true)
  expect(document.documentElement).not.toHaveClass("dark")
  await act(async () => { await store.updateSettings({ theme: "dark" }) })
  expect(document.documentElement).not.toHaveClass("dark")
})
