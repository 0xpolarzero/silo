import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { GeneralPage } from "./general-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

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
