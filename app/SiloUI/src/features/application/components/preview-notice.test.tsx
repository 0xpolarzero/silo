import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"

import { createMemorySettingsStore, createSettingsStore, SettingsProvider, type SettingsStore } from "@/features/preferences/settings-store"
import { PreviewNotice } from "./preview-notice"

function notice(store: SettingsStore) {
  return <SettingsProvider store={store}><PreviewNotice /></SettingsProvider>
}

it("warns about data loss until dismissed, and stays dismissed after remount", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore()
  const view = render(notice(store))
  expect(await screen.findByRole("region", { name: "Silo is in alpha" })).toHaveTextContent("Export sandboxes you care about regularly")

  await user.click(screen.getByRole("button", { name: "Got it" }))
  expect(screen.queryByRole("region", { name: "Silo is in alpha" })).not.toBeInTheDocument()
  expect(store.getSnapshot().settings.previewNoticeDismissed).toBe(true)

  view.unmount()
  render(notice(store))
  await Promise.resolve()
  expect(screen.queryByRole("region", { name: "Silo is in alpha" })).not.toBeInTheDocument()
})

it("closes from the dismiss button", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore()
  render(notice(store))
  await user.click(await screen.findByRole("button", { name: "Dismiss preview notice" }))
  expect(store.getSnapshot().settings.previewNoticeDismissed).toBe(true)
})

it("stays hidden until saved settings are read", async () => {
  const store = createSettingsStore({
    read: () => new Promise(() => {}),
    subscribe: async () => () => {},
    updateSettings: () => new Promise(() => {}),
    updateOnboardingDraft: () => new Promise(() => {}),
    flush: async () => {},
  })
  render(notice(store))
  await Promise.resolve()
  expect(screen.queryByRole("region", { name: "Silo is in alpha" })).not.toBeInTheDocument()
})
