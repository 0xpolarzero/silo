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
import { remoteWorkspaceTarget, workspaceTarget } from "../model/remote-computers"
import { NetworkPage } from "../pages/network-page"

afterEach(() => { toast.dismiss(); delivered.mockClear(); vi.restoreAllMocks() })

it.each(["add", "edit", "remove"] as const)("names and links remote port %s progress and results using the owning computer", async operation => {
  const local = structuredClone(applicationSourceForScenario("running").workspaces.find(workspace => workspace.machine.kind === "vm" && !workspace.computer)!)
  const target = remoteWorkspaceTarget("office:main", "same:vm")
  const remote = { ...local, machine: { ...local.machine, id: target }, computer: { id: "office:main", name: "Office Mac", address: "owner@office", connected: true, vmId: "same:vm" } }
  const other = { ...local, machine: { ...local.machine, id: remoteWorkspaceTarget("laptop", "same:vm") }, computer: { id: "laptop", name: "Laptop", address: "owner@laptop", connected: true, vmId: "same:vm" } }
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

it("keeps remote failure and retry identity even beside same-named sandboxes", async () => {
  const local = structuredClone(applicationSourceForScenario("running").workspaces.find(workspace => workspace.machine.kind === "vm" && !workspace.computer)!)
  const target = remoteWorkspaceTarget("office", "vm-1")
  const remote = { ...local, machine: { ...local.machine, id: target }, computer: { id: "office", name: "Office Mac", address: "owner@office", connected: true, vmId: "vm-1" } }
  const work = vi.fn().mockRejectedValueOnce(new Error("Port occupied")).mockResolvedValue(undefined)
  render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /><NetworkPage workspaces={[local, remote]} browser="Firefox" active={false} actions={{ saveNetworkPort: work } as unknown as ApplicationActions} network={{ workspaces: [] }} /></SettingsProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Add port" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Sandbox" }), target)
  await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9000")
  await user.click(screen.getByRole("button", { name: "Add" }))
  const title = `Could not add port 9000 · ${local.machine.name} · Office Mac`
  expect(await screen.findByText(title)).toBeVisible()
  expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ title, body: "Port occupied", sandbox: { id: target, name: local.machine.name } }))
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText(`Port 9000 added · ${local.machine.name} · Office Mac`)).toBeInTheDocument()
  expect(work).toHaveBeenNthCalledWith(2, { workspace: target, port: 9000, hostPort: null, scheme: "http" })
})
