import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { nextComputerOrder, computerOrderKey } from "@/features/computers/model/computer-order"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function sourceWithRemote(): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const remote = source.computers.find(({ configuration }) => configuration.name === "personal")!
  remote.device = { id: "office", computerId: "vm-1", name: "Office", address: "office.test", connected: true }
  source.devices = [{ id: "office", name: "Office", address: "office.test", connected: true } as NonNullable<ApplicationSource["devices"]>[number]]
  return source
}

const rowNames = () => [...screen.getByRole("list", { name: "Configured computers" }).querySelectorAll("li[data-computer-name]")].map(row => row.getAttribute("data-computer-name"))

it("keys local computers by id and remote ones by device and computer id", () => {
  const source = sourceWithRemote()
  const local = source.computers.find(({ configuration }) => configuration.name === "playgrounds")!
  const remote = source.computers.find(({ configuration }) => configuration.name === "personal")!
  expect(computerOrderKey(local)).toBe(`local:${local.configuration.id}`)
  expect(computerOrderKey(remote)).toBe("remote:office:vm-1")
})

it("keeps saved keys of rows that are not shown after the rows that are", () => {
  expect(nextComputerOrder(["remote:gone:1", "local:a", "local:b"], ["local:b", "local:a"])).toEqual(["local:b", "local:a", "remote:gone:1"])
})

it("reorders a remote computer in this device's own order without changing any configuration", async () => {
  const source = sourceWithRemote()
  const store = createMemorySettingsStore()
  const onConfigurationsChange = vi.fn()
  const user = userEvent.setup()
  render(<SettingsProvider store={store}><OverviewPage source={source} actions={{} as ApplicationActions} onConfigurationsChange={onConfigurationsChange} /></SettingsProvider>)
  const before = rowNames()
  const from = before.indexOf("personal")
  expect(from).toBeGreaterThan(0)

  screen.getByRole("button", { name: "Reorder personal" }).focus()
  await user.keyboard("{ArrowUp}")

  const after = rowNames()
  expect(after.indexOf("personal")).toBe(from - 1)
  expect(onConfigurationsChange).not.toHaveBeenCalled()
  const remote = source.computers.find(({ configuration }) => configuration.name === "personal")!
  expect(store.getSnapshot().settings.computerOrder).toContain(computerOrderKey(remote))
})

it("shows the list in the saved order, with computers it has not placed yet at the end", () => {
  const source = sourceWithRemote()
  const byName = (name: string) => source.computers.find(({ configuration }) => configuration.name === name)!
  const store = createMemorySettingsStore({ computerOrder: [computerOrderKey(byName("personal")), computerOrderKey(byName("playgrounds"))] })
  render(<SettingsProvider store={store}><OverviewPage source={source} actions={{} as ApplicationActions} onConfigurationsChange={vi.fn()} /></SettingsProvider>)
  // Saved rows first in their saved order, then the rest in their usual order.
  expect(rowNames()).toEqual(["personal", "playgrounds", "dev"])
})
