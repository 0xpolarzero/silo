import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { toast } from "sonner"

const delivered = vi.hoisted(() => vi.fn())
vi.mock("@/desktop/notices", async importOriginal => ({ ...await importOriginal<typeof import("@/desktop/notices")>(), deliverNotice: delivered }))

import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { remoteComputerTarget, computerTarget } from "../model/connections"
import { NetworkPage } from "../pages/network-page"

afterEach(() => { toast.dismiss(); delivered.mockClear(); vi.restoreAllMocks() })

it.each(["add", "edit", "remove"] as const)("names and links remote port %s progress and results using the owning device", async operation => {
  const local = structuredClone(applicationSourceForScenario("running").computers.find(computer => !computer.device)!)
  const target = remoteComputerTarget("office:main", "same:vm")
  const remote = { ...local, configuration: { ...local.configuration, id: target }, device: { id: "office:main", name: "Office Mac", address: "owner@office", connected: true, computerId: "same:vm" } }
  const other = { ...local, configuration: { ...local.configuration, id: remoteComputerTarget("laptop", "same:vm") }, device: { id: "laptop", name: "Laptop", address: "owner@laptop", connected: true, computerId: "same:vm" } }
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const work = vi.fn(() => pending)
  const actions = { saveNetworkPort: work, removeNetworkPort: work } as unknown as ApplicationActions
  const port = operation === "add" ? 9000 : 3000
  const verb = operation === "add" ? "Adding" : operation === "edit" ? "Saving" : "Removing"
  const step = operation === "add" ? "Publishing" : verb
  const result = operation === "add" ? "added" : operation === "edit" ? "saved" : "removed"
  render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><NetworkPage computers={[local, remote, other]} browser="Firefox" active={false} actions={actions}
    network={{ computers: [local, remote, other].map(computer => ({ computer: computerTarget(computer), error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", state: "reachable", configured: true }] })) }} /></SettingsProvider>)
  const user = userEvent.setup()
  if (operation === "add") {
    await user.click(screen.getByRole("button", { name: "Add port" }))
    await user.selectOptions(screen.getByRole("combobox", { name: "Computer" }), target)
    await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9000")
    await user.click(screen.getByRole("button", { name: "Add" }))
  } else {
    const row = screen.getAllByRole("row").find(row => row.textContent?.includes("Office Mac"))!
    await user.click(within(row).getByRole("button", { name: `${operation === "edit" ? "Edit" : "Remove"} port 3000 from ${local.configuration.name}` }))
    if (operation === "edit") await user.click(screen.getByRole("button", { name: "Save" }))
    else await user.click(screen.getByRole("button", { name: "Remove" }))
  }
  expect(await screen.findByText(`${verb} port ${port} · ${local.configuration.name} · Office Mac`)).toBeVisible()
  expect(screen.getByRole("progressbar", { name: `${step} port ${port} · ${local.configuration.name} · Office Mac` })).toBeInTheDocument()
  const started = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(started + 4000)
  await act(async () => { finish(); await pending })
  const title = `Port ${port} ${result} · ${local.configuration.name} · Office Mac`
  expect(await screen.findByText(title)).toBeVisible()
  expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ title, computer: { id: target, name: local.configuration.name } }))
})

it("keeps the remote native failure reason and retry identity beside same-named computers", async () => {
  const local = structuredClone(applicationSourceForScenario("running").computers.find(computer => !computer.device)!)
  const target = remoteComputerTarget("office", "vm-1")
  const remote = { ...local, configuration: { ...local.configuration, id: target }, device: { id: "office", name: "Office Mac", address: "owner@office", connected: true, computerId: "vm-1" } }
  const message = "Another computer operation is still running. Wait for it to finish, then retry."
  const work = vi.fn().mockRejectedValueOnce({ code: "busy", message }).mockResolvedValue(undefined)
  render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><NetworkPage computers={[local, remote]} browser="Firefox" active={false} actions={{ saveNetworkPort: work } as unknown as ApplicationActions} network={{ computers: [] }} /></SettingsProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Add port" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Computer" }), target)
  await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9000")
  await user.click(screen.getByRole("button", { name: "Add" }))
  const title = `Could not add port 9000 · ${local.configuration.name} · Office Mac`
  expect(await screen.findByText(title)).toBeVisible()
  expect(screen.getByText(message)).toBeVisible()
  expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ title, body: message, computer: { id: target, name: local.configuration.name } }))
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText(`Port 9000 added · ${local.configuration.name} · Office Mac`)).toBeInTheDocument()
  expect(work).toHaveBeenNthCalledWith(2, { computer: target, port: 9000, hostPort: null, scheme: "http" })
})

it("keeps browser-open failures separate for equally named computers and devices", async () => {
  const local = structuredClone(applicationSourceForScenario("running").computers.find(computer => !computer.device)!)
  const remotes = ["office-a", "office-b"].map(id => ({ ...local, configuration: { ...local.configuration, id: remoteComputerTarget(id, "vm-1") }, device: { id, name: "Office", address: `owner@${id}`, connected: true, computerId: "vm-1" } }))
  const open = vi.fn().mockRejectedValue(new Error("Browser unavailable"))
  render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><NetworkPage computers={remotes} browser="Firefox" active={false} actions={{ openNetworkPort: open } as unknown as ApplicationActions}
    network={{ computers: remotes.map(computer => ({ computer: computerTarget(computer), error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", state: "reachable", configured: true }] })) }} /></SettingsProvider>)
  const user = userEvent.setup()
  for (const button of screen.getAllByRole("button", { name: "Open port 3000 in browser" })) await user.click(button)
  expect(delivered.mock.calls.map(([notice]) => notice.key)).toEqual(remotes.map(computer => `network-port-open:${computer.configuration.id}:3000`))
  expect(delivered.mock.calls.map(([notice]) => notice.computer.id)).toEqual(remotes.map(computer => computer.configuration.id))
  expect(screen.getAllByText(`Could not open port 3000 · ${local.configuration.name} · Office`)).toHaveLength(2)
})
