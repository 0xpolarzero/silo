import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { GeneralPage } from "./general-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createMemorySettingsStore, createSettingsStore, SettingsProvider, type SettingsBackend, type SettingsSnapshot } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"
import { PreUpgradeBackupProvider } from "@/features/storage/pre-upgrade-backup"
import { createFixturePreUpgradeBackup } from "@/fixtures/pre-upgrade-backup"
import { Toaster } from "@/components/ui/sonner"

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

it("defaults the startup selection to a local sandbox even when a remote one is named dev", async () => {
  const user = userEvent.setup()
  const source = structuredClone(applicationSourceForScenario("running"))
  const [dev, playgrounds] = source.workspaces
  source.workspaces = [{ ...dev, machine: { ...dev.machine, id: "remote-dev" }, device: { id: "office", name: "Office Mac", address: "office.local", connected: true, vmId: dev.machine.id } }, playgrounds]
  source.preferences = { ...source.preferences, startWorkspacesAtLaunch: false, startupWorkspaceIds: undefined }
  const settings = createMemorySettingsStore({})
  render(<SettingsProvider store={settings}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(settings)}><GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} /></SystemIntegrationProvider></SettingsProvider>)
  await user.click(screen.getByRole("switch", { name: "Start sandboxes at launch" }))
  expect(settings.getSnapshot().settings.startupWorkspaceIds).toEqual([playgrounds.machine.id])
  expect(screen.getByRole("button", { name: `Remove ${playgrounds.machine.name}` })).toBeVisible()
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

function renderGeneralPage(backup?: ReturnType<typeof createFixturePreUpgradeBackup>) {
  const source = applicationSourceForScenario("running")
  const settings = createMemorySettingsStore(source.preferences)
  const page = <GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} />
  return render(<SettingsProvider store={settings}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(settings)}><Toaster />{backup ? <PreUpgradeBackupProvider backend={backup}>{page}</PreUpgradeBackupProvider> : page}</SystemIntegrationProvider></SettingsProvider>)
}

it("lists the pre-upgrade backup under Storage, after the other sections, until it is deleted", async () => {
  const user = userEvent.setup()
  const backup = createFixturePreUpgradeBackup()
  renderGeneralPage(backup)
  const storage = await screen.findByRole("region", { name: "Storage" })
  const headings = screen.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)
  expect(headings.slice(-2)).toEqual(["Accessibility", "Storage"])
  expect(storage).toHaveTextContent("Pre-upgrade backup")
  expect(await screen.findByText("12.40 GiB · deleted on October 15, 2026")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Delete now" }))
  await user.click(await screen.findByRole("button", { name: "Delete permanently" }))
  await waitFor(() => expect(screen.queryByRole("region", { name: "Storage" })).not.toBeInTheDocument())
  expect(backup.calls).toContain("remove")
})

it("has no Storage section without a pre-upgrade backup", async () => {
  const backup = createFixturePreUpgradeBackup({ gone: true })
  renderGeneralPage(backup)
  await waitFor(() => expect(backup.calls).toEqual(["read"]))
  expect(screen.queryByRole("region", { name: "Storage" })).not.toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Accessibility" })).toBeVisible()
})

it("reports unsaved preferences and retries delivery without losing the selection", async () => {
  const user = userEvent.setup()
  const errors = vi.spyOn(console, "error").mockImplementation(() => {})
  const source = applicationSourceForScenario("running")
  let saved: SettingsSnapshot = { revision: 0, settings: { startWorkspacesAtLaunch: false }, onboardingDraft: null, saveError: null }
  let failDelivery = true
  const settings = createSettingsStore({
    read: async () => saved, subscribe: async () => () => {},
    updateSettings: async (patch) => {
      if (failDelivery) throw new Error("Settings delivery unavailable")
      return (saved = { ...saved, revision: saved.revision + 1, settings: { ...saved.settings, ...patch } })
    },
    updateOnboardingDraft: async () => saved, flush: async () => {},
  }, {}, saved)
  render(<SettingsProvider store={settings}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(settings)}><GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} /></SystemIntegrationProvider></SettingsProvider>)
  await user.click(screen.getByRole("switch", { name: "Start sandboxes at launch" }))
  expect(errors).toHaveBeenCalledExactlyOnceWith("Silo settings:", "Settings delivery unavailable")
  errors.mockRestore()
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings could not be saved")
  expect(screen.getByRole("switch", { name: "Start sandboxes at launch" })).toBeChecked()
  expect(saved.settings.startWorkspacesAtLaunch).toBe(false)
  failDelivery = false
  await user.click(screen.getByRole("button", { name: "Retry saving settings" }))
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
  expect(saved.settings.startWorkspacesAtLaunch).toBe(true)
  settings.dispose()
})

it("explains write-protected settings without offering a save retry", () => {
  const source = applicationSourceForScenario("running")
  const saved: SettingsSnapshot = { revision: 0, settings: {}, onboardingDraft: null, saveError: "Settings use an unsupported file version", writeProtected: true }
  const settings = createSettingsStore({
    read: async () => saved, subscribe: async () => () => {}, updateSettings: async () => saved,
    updateOnboardingDraft: async () => saved, flush: async () => {},
  }, {}, saved)
  render(<SettingsProvider store={settings}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(settings)}><GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} /></SystemIntegrationProvider></SettingsProvider>)
  expect(screen.getByRole("alert")).toHaveTextContent("Changes last for this session")
  expect(screen.queryByRole("button", { name: "Retry saving settings" })).not.toBeInTheDocument()
  settings.dispose()
})
