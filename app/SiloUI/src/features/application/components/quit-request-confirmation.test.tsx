import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { expect, it, vi } from "vitest"

import type { QuitRequest } from "@/desktop/settings"
import { ApplicationApp } from "@/features/application/application-app"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { SettingsProvider, useSettings } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"
import { fixtureApplicationCatalog } from "@/fixtures/application-catalog"
import { useUnavailableBackup } from "@/fixtures/application-backup"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import { QuitRequestConfirmation, type ConnectQuitConfirmation } from "./quit-request-confirmation"

function fakeConnection() {
  let ask: ((request: QuitRequest) => Promise<boolean>) | undefined
  const stop = vi.fn()
  const connect: ConnectQuitConfirmation = vi.fn(async (receive) => { ask = receive; return stop })
  return { connect, stop, ask: (request: QuitRequest) => ask!(request) }
}

it("asks before Quit stops running sandboxes, with the tray's wording, and answers each request", async () => {
  const user = userEvent.setup()
  const connection = fakeConnection()
  render(<QuitRequestConfirmation connect={connection.connect} />)
  await waitFor(() => expect(connection.connect).toHaveBeenCalledTimes(1))

  const quit = connection.ask({ requestId: 1, sandboxes: ["dev", "api"] })
  const dialog = await screen.findByRole("alertdialog", { name: "Quit Silo?" })
  expect(dialog).toHaveAccessibleDescription("This stops 2 running sandboxes: dev, api.")
  expect(within(dialog).getByRole("button", { name: "Quit and stop" })).toHaveFocus()
  await user.click(within(dialog).getByRole("button", { name: "Quit and stop" }))
  await expect(quit).resolves.toBe(true)
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())

  const cancelled = connection.ask({ requestId: 2, sandboxes: ["dev"] })
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
  await expect(cancelled).resolves.toBe(false)

  const escaped = connection.ask({ requestId: 3, sandboxes: ["dev"] })
  await screen.findByRole("alertdialog")
  await user.keyboard("{Escape}")
  await expect(escaped).resolves.toBe(false)
})

it("still asks when the running sandboxes could not be read", async () => {
  const connection = fakeConnection()
  render(<QuitRequestConfirmation connect={connection.connect} />)
  await waitFor(() => expect(connection.connect).toHaveBeenCalled())
  void connection.ask({ requestId: 1, sandboxes: [] })
  expect(await screen.findByRole("alertdialog", { name: "Quit Silo?" })).toHaveAccessibleDescription(/could not check which sandboxes are running/)
})

it("keeps Silo open and stops listening when the window's UI goes away mid-question", async () => {
  const connection = fakeConnection()
  const view = render(<QuitRequestConfirmation connect={connection.connect} />)
  await waitFor(() => expect(connection.connect).toHaveBeenCalled())
  const quit = connection.ask({ requestId: 1, sandboxes: ["dev"] })
  await screen.findByRole("alertdialog")
  view.unmount()
  await expect(quit).resolves.toBe(false)
  expect(connection.stop).toHaveBeenCalled()
})

function MainWindow({ source, connect }: { source: ApplicationSource; connect: ConnectQuitConfirmation }) {
  const { store } = useSettings(source.preferences)
  const [systemIntegrations] = useState(() => createFixtureSystemIntegrationStore(store))
  const backup = useUnavailableBackup(source)
  return <SettingsProvider store={store}><SystemIntegrationProvider store={systemIntegrations}><ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}>
    <ApplicationApp source={source} backup={backup} actions={{} as ApplicationActions} connectQuitConfirmation={connect} />
  </ApplicationCatalogProvider></SystemIntegrationProvider></SettingsProvider>
}

it("connects the main window's Quit requests (⌘Q, menus, Dock) to the confirmation", async () => {
  const user = userEvent.setup()
  const connection = fakeConnection()
  render(<MainWindow source={applicationSourceForScenario("running")} connect={connection.connect} />)
  await waitFor(() => expect(connection.connect).toHaveBeenCalledTimes(1))
  const quit = connection.ask({ requestId: 7, sandboxes: ["dev"] })
  await user.click(within(await screen.findByRole("alertdialog", { name: "Quit Silo?" })).getByRole("button", { name: "Quit and stop" }))
  await expect(quit).resolves.toBe(true)
})
