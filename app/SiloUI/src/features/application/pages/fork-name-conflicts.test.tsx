import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationWorkspace } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function localVm(source: ReturnType<typeof applicationSourceForScenario>, name: string): ApplicationWorkspace {
  return source.workspaces.find(item => item.machine.kind === "vm" && !item.computer && item.machine.name === name)!
}

it("rejects a current-state fork name that another sandbox on this computer already uses", async () => {
  const forkCheckpoint = vi.fn()
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = localVm(source, "dev")
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ forkCheckpoint } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "playgrounds")

  expect(screen.getByText("A sandbox named playgrounds already exists.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()
  expect(forkCheckpoint).not.toHaveBeenCalled()
})

it("rejects a checkpoint fork name that another sandbox on this computer already uses", async () => {
  const forkCheckpoint = vi.fn()
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = localVm(source, "dev")
  const office = { id: "office", name: "Office", address: "office.local", connected: true }
  const remote = structuredClone(localVm(source, "playgrounds"))
  source.workspaces.push({ ...remote, machine: { ...remote.machine, id: "remote-vm", name: "remote-only" }, computer: { ...office, vmId: "remote-vm" } })
  source.remoteComputers = [office]
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ forkCheckpoint } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getAllByRole("button", { name: `More actions for ${workspace.machine.name}` })[0])
  await user.click(screen.getByRole("menuitem", { name: `Checkpoints for ${workspace.machine.name}` }))
  const panel = within(screen.getByRole("region", { name: `Checkpoints for ${workspace.machine.name}` }))
  const checkpoint = workspace.checkpoints![0]
  await user.click(panel.getByRole("button", { name: `Checkpoint actions for ${checkpoint.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Fork ${checkpoint.name}` }))
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "personal")

  expect(screen.getByText("A sandbox named personal already exists.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()

  // A name that is only used on another computer stays available here.
  await user.clear(screen.getByRole("textbox", { name: "New sandbox name" }))
  await user.type(screen.getByRole("textbox", { name: "New sandbox name" }), "remote-only")
  expect(screen.queryByText(/already exists/)).toBeNull()
  expect(screen.getByRole("button", { name: "Fork" })).toBeEnabled()
})
