import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { nextSandboxOrder, sandboxOrderKey } from "@/features/sandboxes/model/sandbox-order"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function sourceWithRemote(): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const remote = source.workspaces.find(({ machine }) => machine.name === "personal")!
  remote.device = { id: "office", vmId: "vm-1", name: "Office", address: "office.test", connected: true }
  source.devices = [{ id: "office", name: "Office", address: "office.test", connected: true } as NonNullable<ApplicationSource["devices"]>[number]]
  return source
}

const rowNames = () => [...screen.getByRole("list", { name: "Configured sandboxes" }).querySelectorAll("li[data-sandbox-name]")].map(row => row.getAttribute("data-sandbox-name"))

it("keys local sandboxes by id and remote ones by device and sandbox id", () => {
  const source = sourceWithRemote()
  const local = source.workspaces.find(({ machine }) => machine.name === "playgrounds")!
  const remote = source.workspaces.find(({ machine }) => machine.name === "personal")!
  expect(sandboxOrderKey(local)).toBe(`local:${local.machine.id}`)
  expect(sandboxOrderKey(remote)).toBe("remote:office:vm-1")
})

it("keeps saved keys of rows that are not shown after the rows that are", () => {
  expect(nextSandboxOrder(["remote:gone:1", "local:a", "local:b"], ["local:b", "local:a"])).toEqual(["local:b", "local:a", "remote:gone:1"])
})

it("reorders a remote sandbox in this device's own order without changing any configuration", async () => {
  const source = sourceWithRemote()
  const store = createMemorySettingsStore()
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  render(<SettingsProvider store={store}><OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={onMachinesChange} /></SettingsProvider>)
  const before = rowNames()
  const from = before.indexOf("personal")
  expect(from).toBeGreaterThan(0)

  screen.getByRole("button", { name: "Reorder personal" }).focus()
  await user.keyboard("{ArrowUp}")

  const after = rowNames()
  expect(after.indexOf("personal")).toBe(from - 1)
  expect(onMachinesChange).not.toHaveBeenCalled()
  const remote = source.workspaces.find(({ machine }) => machine.name === "personal")!
  expect(store.getSnapshot().settings.sandboxOrder).toContain(sandboxOrderKey(remote))
})

it("shows the list in the saved order, with sandboxes it has not placed yet at the end", () => {
  const source = sourceWithRemote()
  const byName = (name: string) => source.workspaces.find(({ machine }) => machine.name === name)!
  const store = createMemorySettingsStore({ sandboxOrder: [sandboxOrderKey(byName("personal")), sandboxOrderKey(byName("playgrounds"))] })
  render(<SettingsProvider store={store}><OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} /></SettingsProvider>)
  // Saved rows first in their saved order, then the rest in their usual order.
  expect(rowNames()).toEqual(["personal", "playgrounds", "dev"])
})
