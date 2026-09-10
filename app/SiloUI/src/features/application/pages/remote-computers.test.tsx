import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"
import { remoteWorkspaceTarget } from "../model/remote-computers"

function setup(connected = true) {
  const source = applicationSourceForScenario("running")
  const computer = { id: "office", name: "Office Mac", address: "user@office", connected }
  const remote = structuredClone(source.workspaces[0])
  remote.computer = { ...computer, vmId: remote.machine.id }
  remote.machine.id = remoteWorkspaceTarget(computer.id, remote.machine.id)
  remote.freshness = connected ? "fresh" : "stale"
  source.workspaces.push(remote)
  source.remoteComputers = [computer]
  const actions = { saveRemoteMachine: vi.fn().mockResolvedValue(undefined), deleteRemoteMachine: vi.fn().mockResolvedValue(undefined), startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(), connectComputer: vi.fn() } as unknown as ApplicationActions
  const onMachinesChange = vi.fn()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} />)
  return { source, remote, actions, onMachinesChange, user: userEvent.setup() }
}

it("keeps the existing VM list and shows remote ownership through a focusable badge", async () => {
  const { remote, actions, user } = setup()
  const badge = screen.getByLabelText(/Remote VM on Office Mac/)
  expect(badge).toHaveAttribute("tabindex", "0")
  const row = within(badge.closest("li")!)
  expect(row.queryByText("Restart required")).not.toBeInTheDocument()
  await user.click(row.getByRole("button", { name: `Stop ${remote.machine.name}` }))
  expect(actions.stopWorkspace).toHaveBeenCalledWith(remote.machine.id)
  await user.click(row.getByRole("button", { name: `Delete ${remote.machine.name} on Office Mac` }))
  expect(row.getByText("Delete on Office Mac?")).toBeVisible()
  await user.click(row.getByRole("button", { name: `Confirm deletion of ${remote.machine.name} on Office Mac` }))
  expect(actions.deleteRemoteMachine).toHaveBeenCalledWith("office", remote.machine)
})

it("disables remote lifecycle operations while preserving last-known rows when the computer is unavailable", () => {
  const { remote } = setup(false)
  const row = within(screen.getByLabelText(/Remote VM on Office Mac/).closest("li")!)
  expect(row.getByText("Unavailable")).toBeVisible()
  expect(row.getByRole("button", { name: `Stop ${remote.machine.name}` })).toBeDisabled()
  expect(row.queryByRole("button", { name: `Delete ${remote.machine.name} on Office Mac` })).not.toBeInTheDocument()
})

it("creates a VM on the selected computer without rewriting the local inventory", async () => {
  const { actions, onMachinesChange, user } = setup()
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "office")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(actions.saveRemoteMachine).toHaveBeenCalledWith("office", expect.objectContaining({ kind: "vm" }), undefined)
  expect(onMachinesChange).not.toHaveBeenCalled()
})

it("edits a remote VM with the same name as a local VM using its original configuration", async () => {
  const { actions, remote, user } = setup()
  const row = within(screen.getByLabelText(/Remote VM on Office Mac/).closest("li")!)
  await user.click(row.getByRole("button", { name: `Edit ${remote.machine.name}` }))
  expect(screen.getByRole("combobox", { name: "Run on" })).toBeDisabled()
  await user.click(screen.getByRole("button", { name: "Stop VM and save" }))
  expect(actions.saveRemoteMachine).toHaveBeenCalledWith("office", remote.machine, remote.machine)
})

it("removes the last VM from a remote computer and can create from an empty list", async () => {
  const source = applicationSourceForScenario("running")
  const original = source.workspaces[0]
  const computer = { id: "office", name: "Office Mac", address: "user@office", connected: true }
  const remote = { ...original, machine: { ...original.machine, id: remoteWorkspaceTarget("office", original.machine.id) }, computer: { ...computer, vmId: original.machine.id } }
  source.workspaces = [remote]
  source.remoteComputers = [computer]
  const actions = { saveRemoteMachine: vi.fn().mockResolvedValue(undefined), deleteRemoteMachine: vi.fn().mockResolvedValue(undefined), stopWorkspace: vi.fn(), restartWorkspace: vi.fn() } as unknown as ApplicationActions
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: `Delete ${remote.machine.name} on Office Mac` }))
  await user.click(screen.getByRole("button", { name: `Confirm deletion of ${remote.machine.name} on Office Mac` }))
  expect(actions.deleteRemoteMachine).toHaveBeenCalledWith("office", remote.machine)
  view.rerender(<OverviewPage source={{ ...source, workspaces: [] }} actions={actions} onMachinesChange={onMachinesChange} />)
  expect(screen.getByText("0 configured · 0 VM · 0 SSH")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "office")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(actions.saveRemoteMachine).toHaveBeenCalledWith("office", expect.objectContaining({ kind: "vm" }), undefined)
})

it("permits removing the last local VM without affecting connected computers", async () => {
  const source = applicationSourceForScenario("running")
  source.workspaces = [source.workspaces[0]]
  const machine = source.workspaces[0].machine
  const actions = { saveRemoteMachine: vi.fn(), deleteRemoteMachine: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn() } as unknown as ApplicationActions
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: `Delete ${machine.name}` }))
  await user.click(screen.getByRole("button", { name: `Confirm deletion of ${machine.name}` }))
  expect(onMachinesChange).toHaveBeenCalledWith([])
  expect(actions.deleteRemoteMachine).not.toHaveBeenCalled()
})
