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
import { remoteWorkspaceTarget, workspaceTarget } from "../model/connections"
import { NetworkPage } from "../pages/network-page"

afterEach(() => { toast.dismiss(); delivered.mockClear(); vi.restoreAllMocks() })

it.each(["add", "edit", "remove"] as const)("names and links remote port %s progress and results using the owning device", async operation => {
  const local = structuredClone(applicationSourceForScenario("running").workspaces.find(workspace => !workspace.device)!)
  const target = remoteWorkspaceTarget("office:main", "same:vm")
  const remote = { ...local, machine: { ...local.machine, id: target }, device: { id: "office:main", name: "Office Mac", address: "owner@office", connected: true, vmId: "same:vm" } }
  const other = { ...local, machine: { ...local.machine, id: remoteWorkspaceTarget("laptop", "same:vm") }, device: { id: "laptop", name: "Laptop", address: "owner@laptop", connected: true, vmId: "same:vm" } }
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const work = vi.fn(() => pending)
  const actions = { saveNetworkPort: work, removeNetworkPort: work } as unknown as ApplicationActions
  const port = operation === "add" ? 9000 : 3000
  const verb = operation === "add" ? "Adding" : operation === "edit" ? "Saving" : "Removing"
  const step = operation === "add" ? "Publishing" : verb
  const result = operation === "add" ? "added" : operation === "edit" ? "saved" : "removed"
  render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><NetworkPage workspaces={[local, remote, other]} browser="Firefox" active={false} actions={actions}
    network={{ workspaces: [local, remote, other].map(workspace => ({ workspace: workspaceTarget(workspace), error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", state: "reachable", configured: true }] })) }} /></SettingsProvider>)
  const user = userEvent.setup()
  if (operation === "add") {
    await user.click(screen.getByRole("button", { name: "Add port" }))
    await user.selectOptions(screen.getByRole("combobox", { name: "Sandbox" }), target)
    await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9000")
    await user.click(screen.getByRole("button", { name: "Add" }))
  } else {
    const row = screen.getAllByRole("row").find(row => row.textContent?.includes("Office Mac"))!
    await user.click(within(row).getByRole("button", { name: `${operation === "edit" ? "Edit" : "Remove"} port 3000 from ${local.machine.name}` }))
    if (operation === "edit") await user.click(screen.getByRole("button", { name: "Save" }))
    else await user.click(screen.getByRole("button", { name: "Remove" }))
  }
  expect(await screen.findByText(`${verb} port ${port} · ${local.machine.name} · Office Mac`)).toBeVisible()
  expect(screen.getByRole("progressbar", { name: `${step} port ${port} · ${local.machine.name} · Office Mac` })).toBeInTheDocument()
  const started = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(started + 4000)
  await act(async () => { finish(); await pending })
  const title = `Port ${port} ${result} · ${local.machine.name} · Office Mac`
  expect(await screen.findByText(title)).toBeVisible()
  expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ title, sandbox: { id: target, name: local.machine.name } }))
})

it("keeps the remote native failure reason and retry identity beside same-named sandboxes", async () => {
  const local = structuredClone(applicationSourceForScenario("running").workspaces.find(workspace => !workspace.device)!)
  const target = remoteWorkspaceTarget("office", "vm-1")
  const remote = { ...local, machine: { ...local.machine, id: target }, device: { id: "office", name: "Office Mac", address: "owner@office", connected: true, vmId: "vm-1" } }
  const message = "Another sandbox operation is still running. Wait for it to finish, then retry."
  const work = vi.fn().mockRejectedValueOnce({ code: "busy", message }).mockResolvedValue(undefined)
  render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><NetworkPage workspaces={[local, remote]} browser="Firefox" active={false} actions={{ saveNetworkPort: work } as unknown as ApplicationActions} network={{ workspaces: [] }} /></SettingsProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Add port" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Sandbox" }), target)
  await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9000")
  await user.click(screen.getByRole("button", { name: "Add" }))
  const title = `Could not add port 9000 · ${local.machine.name} · Office Mac`
  expect(await screen.findByText(title)).toBeVisible()
  expect(screen.getByText(message)).toBeVisible()
  expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ title, body: message, sandbox: { id: target, name: local.machine.name } }))
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText(`Port 9000 added · ${local.machine.name} · Office Mac`)).toBeInTheDocument()
  expect(work).toHaveBeenNthCalledWith(2, { workspace: target, port: 9000, hostPort: null, scheme: "http" })
})

it("keeps browser-open failures separate for equally named sandboxes and devices", async () => {
  const local = structuredClone(applicationSourceForScenario("running").workspaces.find(workspace => !workspace.device)!)
  const remotes = ["office-a", "office-b"].map(id => ({ ...local, machine: { ...local.machine, id: remoteWorkspaceTarget(id, "vm-1") }, device: { id, name: "Office", address: `owner@${id}`, connected: true, vmId: "vm-1" } }))
  const open = vi.fn().mockRejectedValue(new Error("Browser unavailable"))
  render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><NetworkPage workspaces={remotes} browser="Firefox" active={false} actions={{ openNetworkPort: open } as unknown as ApplicationActions}
    network={{ workspaces: remotes.map(workspace => ({ workspace: workspaceTarget(workspace), error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", state: "reachable", configured: true }] })) }} /></SettingsProvider>)
  const user = userEvent.setup()
  for (const button of screen.getAllByRole("button", { name: "Open port 3000 in browser" })) await user.click(button)
  expect(delivered.mock.calls.map(([notice]) => notice.key)).toEqual(remotes.map(workspace => `network-port-open:${workspace.machine.id}:3000`))
  expect(delivered.mock.calls.map(([notice]) => notice.sandbox.id)).toEqual(remotes.map(workspace => workspace.machine.id))
  expect(screen.getAllByText(`Could not open port 3000 · ${local.machine.name} · Office`)).toHaveLength(2)
})
