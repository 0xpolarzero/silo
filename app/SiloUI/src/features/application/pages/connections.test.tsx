import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"
import { remoteWorkspaceTarget } from "../model/connections"

function setup(connected = true) {
  const source = applicationSourceForScenario("running")
  const device = { id: "office", name: "Office Mac", address: "user@office", connected }
  const remote = structuredClone(source.workspaces[0])
  remote.device = { ...device, vmId: remote.machine.id }
  remote.machine.id = remoteWorkspaceTarget(device.id, remote.machine.id)
  remote.freshness = connected ? "fresh" : "stale"
  source.workspaces.push(remote)
  source.devices = [device]
  const actions = { saveRemoteMachine: vi.fn().mockResolvedValue(undefined), deleteRemoteMachine: vi.fn().mockResolvedValue(undefined), startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(), connectDevice: vi.fn() } as unknown as ApplicationActions
  const onMachinesChange = vi.fn()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} />)
  return { source, remote, actions, onMachinesChange, view, user: userEvent.setup() }
}

it("keeps the existing VM list and shows remote ownership through a focusable badge", async () => {
  const { remote, actions, user, source, view, onMachinesChange } = setup()
  const badge = screen.getByLabelText(/Sandbox on Office Mac/)
  expect(badge).toHaveAttribute("tabindex", "0")
  const row = within(badge.closest("li")!)
  expect(row.queryByText("Restart required")).not.toBeInTheDocument()
  await user.click(row.getByRole("button", { name: `Stop ${remote.machine.name}` }))
  // Stopping a running sandbox confirms first, naming its device (decision 8).
  const stop = within((await screen.findByText(`Stop ${remote.machine.name} on Office Mac?`)).closest<HTMLElement>("[data-slot=popover-content]")!)
  expect(actions.stopWorkspace).not.toHaveBeenCalled()
  await user.click(stop.getByRole("button", { name: "Stop" }))
  await waitFor(() => expect(actions.stopWorkspace).toHaveBeenCalledWith(remote.machine.id))
  await user.click(row.getByRole("button", { name: `More actions for ${remote.machine.name}` }))
  expect(screen.getByRole("menuitem", { name: `Delete ${remote.machine.name} on Office Mac` })).toHaveAttribute("aria-disabled", "true")
  await user.keyboard("{Escape}")
  remote.state = "stopped"
  view.rerender(<OverviewPage source={{ ...source }} actions={actions} onMachinesChange={onMachinesChange} />)
  await user.click(row.getByRole("button", { name: `More actions for ${remote.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${remote.machine.name} on Office Mac` }))
  expect(await screen.findByText(`Delete ${remote.machine.name} on Office Mac permanently?`)).toBeVisible()
  await user.click(within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name: "Delete permanently" }))
  expect(actions.deleteRemoteMachine).toHaveBeenCalledWith("office", remote.machine)
})

it("disables remote lifecycle operations while preserving last-known rows when the device is unavailable", () => {
  const { remote } = setup(false)
  expect(screen.getByText("4 sandboxes · 3 on this device · 1 on other devices · 0 SSH hosts")).toBeVisible()
  const row = within(screen.getByLabelText(/Sandbox on Office Mac/).closest("li")!)
  expect(row.getByText("Offline · last known status")).toBeVisible()
  expect(row.getByRole("button", { name: `Stop ${remote.machine.name}` })).toBeDisabled()
  expect(row.queryByRole("button", { name: `Delete ${remote.machine.name} on Office Mac` })).not.toBeInTheDocument()
})

it("creates a VM on the selected device without rewriting the local inventory", async () => {
  const { actions, onMachinesChange, user } = setup()
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "office")
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(actions.saveRemoteMachine).toHaveBeenCalledWith("office", expect.objectContaining({ kind: "vm" }), undefined)
  expect(onMachinesChange).not.toHaveBeenCalled()
})

it("edits a remote VM with the same name as a local VM using its original configuration", async () => {
  const { actions, remote, user } = setup()
  const row = within(screen.getByLabelText(/Sandbox on Office Mac/).closest("li")!)
  await user.click(row.getByRole("button", { name: `More actions for ${remote.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${remote.machine.name}` }))
  expect(screen.getByRole("combobox", { name: "Run on" })).toBeDisabled()
  await user.click(screen.getByRole("button", { name: "Stop and save…" }))
  await user.click(screen.getByRole("button", { name: "Stop and save" }))
  expect(actions.saveRemoteMachine).toHaveBeenCalledWith("office", remote.machine, remote.machine)
})

it("removes the last VM from a remote device and can create from an empty list", async () => {
  const source = applicationSourceForScenario("running")
  const original = source.workspaces[0]
  original.state = "stopped"
  const device = { id: "office", name: "Office Mac", address: "user@office", connected: true }
  const remote = { ...original, machine: { ...original.machine, id: remoteWorkspaceTarget("office", original.machine.id) }, device: { ...device, vmId: original.machine.id } }
  source.workspaces = [remote]
  source.devices = [device]
  const actions = { saveRemoteMachine: vi.fn().mockResolvedValue(undefined), deleteRemoteMachine: vi.fn().mockResolvedValue(undefined), stopWorkspace: vi.fn(), restartWorkspace: vi.fn() } as unknown as ApplicationActions
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: `More actions for ${remote.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${remote.machine.name} on Office Mac` }))
  await user.click(within((await screen.findByText(`Delete ${remote.machine.name} on Office Mac permanently?`)).closest<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name: "Delete permanently" }))
  await waitFor(() => expect(actions.deleteRemoteMachine).toHaveBeenCalledWith("office", remote.machine))
  view.rerender(<OverviewPage source={{ ...source, workspaces: [] }} actions={actions} onMachinesChange={onMachinesChange} />)
  expect(screen.getByText("0 sandboxes · 0 on this device · 0 on other devices · 0 SSH hosts")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "office")
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(actions.saveRemoteMachine).toHaveBeenCalledWith("office", expect.objectContaining({ kind: "vm" }), undefined)
})

it("permits removing the last local VM without affecting connected devices", async () => {
  const source = applicationSourceForScenario("running")
  source.workspaces = [source.workspaces[0]]
  source.workspaces[0].state = "stopped"
  const machine = source.workspaces[0].machine
  const actions = { saveRemoteMachine: vi.fn(), deleteRemoteMachine: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn() } as unknown as ApplicationActions
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${machine.name}` }))
  await user.click(within((await screen.findByText(`Delete ${machine.name} permanently?`)).closest<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name: "Delete permanently" }))
  await waitFor(() => expect(onMachinesChange).toHaveBeenCalledWith([], [machine]))
  expect(actions.deleteRemoteMachine).not.toHaveBeenCalled()
})

it("keeps a local edit scoped to local machines when a connected device is removed", async () => {
  const { source, actions, onMachinesChange, user, view } = setup()
  source.workspaces.forEach(workspace => { workspace.state = "stopped" })
  view.rerender(<OverviewPage source={{ ...source }} actions={actions} onMachinesChange={onMachinesChange} />)
  const local = source.workspaces.filter(workspace => !workspace.device).map(workspace => workspace.machine)
  const machine = local[0]!
  const row = within(document.querySelector<HTMLElement>(`li[data-machine-id="${machine.id}"]`)!)
  await user.click(row.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${machine.name}` }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  view.rerender(<OverviewPage source={{ ...source, workspaces: source.workspaces.filter(workspace => !workspace.device), devices: [] }}
    actions={actions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith(local.map(item => item.id === machine.id ? { ...item, cpus: 4 } : item), local)
  expect(actions.saveRemoteMachine).not.toHaveBeenCalled()
})


it("keeps a new sandbox draft when its selected device is removed before Create", async () => {
  const { source, actions, onMachinesChange, user, view } = setup()
  render(<Toaster />)
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "office")
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "2")
  view.rerender(<OverviewPage source={{ ...source, workspaces: source.workspaces.filter(workspace => !workspace.device), devices: [] }}
    actions={actions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(actions.saveRemoteMachine).not.toHaveBeenCalled()
  expect(onMachinesChange).not.toHaveBeenCalled()
  expect(await screen.findByText("The selected device was removed. Choose another device before saving.")).toBeVisible()
  expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("2")
  await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "")
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(onMachinesChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ cpus: 2 })]), expect.any(Array))
})
