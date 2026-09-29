import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace } from "../model/application-source"
import { OverviewPage } from "./overview-page"

afterEach(() => { toast.dismiss() })

function withCheckpoint() {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  const workspace = source.workspaces.find(item => item.machine.kind === "vm" && !item.computer)!
  workspace.checkpoints = [{ id: "checkpoint-1", name: "Before deploy", createdAt: "2026-09-25T10:00:00.000Z", scope: "full", reason: "manual" }] satisfies NonNullable<ApplicationWorkspace["checkpoints"]>
  return { source, workspace }
}

function Harness({ source, actions }: { source: ApplicationSource; actions: ApplicationActions }) {
  return <SettingsProvider initialSettings={{ theme: "light" }}>
    <Toaster />
    <OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />
  </SettingsProvider>
}

function confirmButton(name: string) { return within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name }) }

it("toasts a created fork with an Open action that navigates to the new sandbox", async () => {
  const { source, workspace } = withCheckpoint()
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  const actions = { forkCheckpoint, restoreCheckpoint: vi.fn(), openTerminal: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  const view = render(<Harness source={source} actions={actions} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Checkpoints for ${workspace.machine.name}` }))
  await user.click(within(screen.getByText("Before deploy").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Checkpoint actions for Before deploy" }))
  await user.click(screen.getByRole("menuitem", { name: "Fork Before deploy" }))
  expect(await screen.findByText("Fork from “Before deploy”")).toBeVisible()
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "experiment")
  await user.click(screen.getByRole("button", { name: "Fork" }))

  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "checkpoint-1", "experiment"))
  expect(await screen.findByText("Fork created")).toBeVisible()
  expect(screen.getByText(/experiment is stopped/)).toBeVisible()

  // The backend snapshot now includes the forked sandbox; Open resolves it fresh and navigates.
  const forked = structuredClone(source)
  const clone = structuredClone(workspace)
  clone.machine = { ...clone.machine, id: "vm-experiment", name: "experiment" }
  clone.checkpoints = []
  forked.workspaces.push(clone)
  view.rerender(<Harness source={forked} actions={actions} />)

  await user.click(screen.getByRole("button", { name: "Open" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesexperiment")
})

it("toasts a created fork from the sandbox current-state menu", async () => {
  const { source, workspace } = withCheckpoint()
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  const actions = { forkCheckpoint } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<Harness source={source} actions={actions} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "spinoff")
  await user.click(screen.getByRole("button", { name: "Fork" }))

  await waitFor(() => expect(forkCheckpoint).toHaveBeenCalledWith(workspace.machine.name, null, "spinoff"))
  expect(await screen.findByText("Fork created")).toBeVisible()
  expect(screen.getByText(/spinoff is stopped/)).toBeVisible()
})

it("toasts a restored checkpoint with a Start action that runs the guarded start", async () => {
  const { source, workspace } = withCheckpoint()
  const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
  const startWorkspace = vi.fn()
  const actions = { restoreCheckpoint, forkCheckpoint: vi.fn(), startWorkspace, openTerminal: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<Harness source={source} actions={actions} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Checkpoints for ${workspace.machine.name}` }))
  await user.click(within(screen.getByText("Before deploy").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Restore" }))
  expect(await screen.findByText("Restore “Before deploy”?")).toBeVisible()
  await user.click(confirmButton("Restore"))

  await waitFor(() => expect(restoreCheckpoint).toHaveBeenCalledWith(workspace.machine.name, "checkpoint-1"))
  expect(await screen.findByText("Restored “Before deploy”")).toBeVisible()
  expect(screen.getByText(new RegExp(`${workspace.machine.name} is stopped\\. A recovery checkpoint was saved first\\.`))).toBeVisible()

  await user.click(screen.getByRole("button", { name: "Start" }))
  expect(startWorkspace).toHaveBeenCalledWith(workspace.machine.name)
})

it("routes the restored-toast Start through the guard, so an unavailable VM operation is blocked", async () => {
  const { source, workspace } = withCheckpoint()
  source.vmOperationsUnavailable = "Local VMs are unavailable while the runtime is repairing."
  const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
  const startWorkspace = vi.fn()
  const actions = { restoreCheckpoint, forkCheckpoint: vi.fn(), startWorkspace, openTerminal: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<Harness source={source} actions={actions} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Checkpoints for ${workspace.machine.name}` }))
  await user.click(within(screen.getByText("Before deploy").closest("[data-checkpoint-name]")!).getByRole("button", { name: "Restore" }))
  await user.click(confirmButton("Restore"))

  await screen.findByText("Restored “Before deploy”")
  await user.click(screen.getByRole("button", { name: "Start" }))
  expect(startWorkspace).not.toHaveBeenCalled()
  expect(screen.getByText("VM operation unavailable")).toBeVisible()
})
