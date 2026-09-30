import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"

import { NotificationsPage } from "./notifications-page"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

function page() {
  const store = createMemorySettingsStore({ notificationsEnabled: true })
  return { store, ui: <SettingsProvider store={store}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(store)}><NotificationsPage /></SystemIntegrationProvider></SettingsProvider> }
}

it("describes the three categories and when notifications appear", async () => {
  render(page().ui)
  expect(await screen.findByText("Silo sends system notifications while its window is in the background. While you're using Silo, results appear in the app.")).toBeInTheDocument()
  expect(screen.getByText("Actions and background work that fail, such as start, push, sandbox export, or sandbox import.")).toBeInTheDocument()
  expect(screen.getByText("A sandbox stops, fails, or recovers without you asking.")).toBeInTheDocument()
  expect(screen.getByText("Work that took more than a few seconds finishes while Silo is in the background.")).toBeInTheDocument()
  for (const name of ["Failures", "Unexpected sandbox changes", "Long tasks finished"]) expect(screen.getByRole("switch", { name })).toBeChecked()
})

it("saves each category under its own setting", async () => {
  const user = userEvent.setup()
  const { store, ui } = page()
  render(ui)
  await user.click(await screen.findByRole("switch", { name: "Long tasks finished" }))
  await user.click(screen.getByRole("switch", { name: "Failures" }))
  expect(store.getSnapshot().settings).toMatchObject({ notifyCompletions: false, notifyFailures: false, notifyChanges: true })
})
