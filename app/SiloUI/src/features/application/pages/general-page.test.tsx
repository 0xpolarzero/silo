import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { GeneralPage } from "./general-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createMemorySettingsStore, createSettingsStore, SettingsProvider, type SettingsBackend, type SettingsSnapshot } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

it.each(["default", "empty"] as const)("persists the %s startup selection when enabled without editing the selection", async (selection) => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running")
  const expected = selection === "default" ? [source.workspaces.find(({ machine }) => machine.name === "dev")!.machine.id] : []
  let saved: SettingsSnapshot = { revision: 0, settings: selection === "empty" ? { startupWorkspaceIds: [] } : {}, onboardingDraft: null, saveError: null }
  const backend: SettingsBackend = {
    read: async () => saved,
    subscribe: async () => () => {},
    updateSettings: async (patch) => (saved = { ...saved, revision: saved.revision + 1, settings: { ...saved.settings, ...patch } }),
    updateOnboardingDraft: async () => saved,
    flush: async () => {},
  }
  const settings = createSettingsStore(backend)
  await settings.initialize()
  const view = render(<SettingsProvider store={settings}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(settings)}><GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} /></SystemIntegrationProvider></SettingsProvider>)

  await user.click(screen.getByRole("switch", { name: "Start sandboxes at launch" }))
  await settings.flush()
  expect(saved.settings).toMatchObject({ startWorkspacesAtLaunch: true, startupWorkspaceIds: expected })
  view.unmount()
  settings.dispose()

  const reopened = createSettingsStore(backend)
  await reopened.initialize()
  expect(reopened.getSnapshot().settings).toMatchObject({ startWorkspacesAtLaunch: true, startupWorkspaceIds: expected })
  reopened.dispose()
})

it("searches a long startup sandbox list and preserves selections when startup is toggled", async () => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running")
  source.workspaces = Array.from({ length: 64 }, (_, index) => ({
    ...source.workspaces[0],
    machine: { ...source.workspaces[0].machine, id: `sandbox-${index + 1}`, name: `sandbox-${index + 1}` },
  }))
  const settings = createMemorySettingsStore(source.preferences)
  render(<SettingsProvider store={settings}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(settings)}><GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} /></SystemIntegrationProvider></SettingsProvider>)
  const startup = screen.getByRole("switch", { name: "Start sandboxes at launch" })
  if (!source.preferences.startWorkspacesAtLaunch) await user.click(startup)
  const input = screen.getByRole("combobox", { name: "Add sandbox at startup" })
  await user.type(input, "sandbox-64")
  expect(screen.getAllByRole("option")).toHaveLength(1)
  await user.keyboard("{Enter}")
  expect(screen.getByRole("button", { name: "Remove sandbox-64" })).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Remove sandbox-1" }))
  await user.click(startup)
  expect(screen.queryByRole("combobox", { name: "Add sandbox at startup" })).not.toBeInTheDocument()
  await user.click(startup)
  expect(screen.getByRole("button", { name: "Remove sandbox-64" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Remove sandbox-1" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Clear" }))
  expect(screen.queryByRole("button", { name: "Remove sandbox-64" })).not.toBeInTheDocument()
})
