import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"

function localVmSource() {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  return source
}

it("opens a sandbox detail page from the row body and returns to the list from the breadcrumb", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ openTerminal: vi.fn() } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)

  // The list heading and the detail breadcrumb root share their styling so opening
  // a sandbox never shifts "Sandboxes".
  const listHeading = screen.getByRole("heading", { name: "Sandboxes" })
  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" })
  expect(breadcrumb).toHaveTextContent(`Sandboxes${workspace.machine.name}`)
  const breadcrumbRoot = within(breadcrumb).getByRole("button", { name: "Sandboxes" })
  expect(breadcrumbRoot.className).toContain("font-medium")
  expect(listHeading.className).toContain("font-medium")
  expect(screen.queryByRole("list", { name: "Configured sandboxes" })).not.toBeInTheDocument()

  await user.click(breadcrumbRoot)
  expect(screen.getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
})

it("opens the Checkpoints tab directly from the row menu", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ createCheckpoint: vi.fn(), forkCheckpoint: vi.fn(), restoreCheckpoint: vi.fn() } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Checkpoints for ${workspace.machine.name}` }))
  expect(screen.getByRole("tab", { name: "Checkpoints" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("region", { name: `Checkpoints for ${workspace.machine.name}` })).toBeVisible()
})

it("hides Storage and Access tabs for a remote sandbox without those capabilities", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.computer = { id: "office", vmId: workspace.machine.id, name: "Office", address: "office.test", connected: true }
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ readWorkspaceStorage: vi.fn(), forkCheckpoint: vi.fn() } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  expect(screen.getByRole("tab", { name: "Overview" })).toBeVisible()
  expect(screen.getByRole("tab", { name: "Checkpoints" })).toBeVisible()
  expect(screen.queryByRole("tab", { name: "Storage" })).not.toBeInTheDocument()
  expect(screen.queryByRole("tab", { name: "Access" })).not.toBeInTheDocument()
})

it("summarizes resources, repositories, and secrets on the Overview tab", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  expect(screen.getByRole("heading", { name: "Resources" })).toBeVisible()
  expect(screen.getByRole("heading", { name: "Repositories" })).toBeVisible()
  expect(screen.getByRole("heading", { name: "Secrets" })).toBeVisible()
})

it("jumps from Overview sections to Files, Network, and Secrets scoped to the sandbox", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const onNavigate = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} onNavigate={onNavigate} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))

  await user.click(screen.getByRole("button", { name: "View all files for this sandbox" }))
  expect(onNavigate).toHaveBeenLastCalledWith({ workspaceSection: "files", workspace: workspace.machine.id })

  await user.click(screen.getByRole("button", { name: "View all network for this sandbox" }))
  expect(onNavigate).toHaveBeenLastCalledWith({ workspaceSection: "network", workspace: workspace.machine.id })

  await user.click(screen.getByRole("button", { name: "View all secrets" }))
  expect(onNavigate).toHaveBeenLastCalledWith({ tab: "secrets" })
})

it("opens the sandbox editor in place on the detail page without leaving it", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${workspace.machine.name}` }))

  // The editor renders on the detail page under an "Edit <name>" label, the tabs are hidden,
  // and the sandbox list is never shown.
  expect(screen.getByRole("heading", { name: `Edit ${workspace.machine.name}` })).toBeVisible()
  expect(screen.getByRole("textbox", { name: "Machine name" })).toBeVisible()
  expect(screen.queryByRole("tab", { name: "Overview" })).not.toBeInTheDocument()
  expect(screen.queryByRole("list", { name: "Configured sandboxes" })).not.toBeInTheDocument()
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(`Sandboxes${workspace.machine.name}`)
})

it("opens the editor in place from the Resources Edit button", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Edit" }))
  expect(screen.getByRole("heading", { name: `Edit ${workspace.machine.name}` })).toBeVisible()
})

it("commits an in-place edit with a baseline and returns to the overview tab", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={onMachinesChange} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Edit" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "4")
  await user.click(screen.getByRole("button", { name: /save/i }))

  // The commit carries a baseline (targeted change), the editor closes, and the detail page
  // stays open on the same sandbox rather than returning to the list.
  expect(onMachinesChange).toHaveBeenCalledWith(expect.any(Array), expect.any(Array))
  expect(screen.queryByRole("heading", { name: `Edit ${workspace.machine.name}` })).not.toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Resources" })).toBeVisible()
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(`Sandboxes${workspace.machine.name}`)
  expect(screen.queryByRole("list", { name: "Configured sandboxes" })).not.toBeInTheDocument()
})

it("cancels an in-place edit without committing", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={onMachinesChange} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Edit" }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))

  expect(onMachinesChange).not.toHaveBeenCalled()
  expect(screen.queryByRole("heading", { name: `Edit ${workspace.machine.name}` })).not.toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Resources" })).toBeVisible()
})

it("shows the stale-edit conflict review in place when a save is rejected", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const onMachinesChange = vi.fn().mockRejectedValue(new Error("This VM changed while your edit was waiting. Review it and try again."))
  // A defined saveRemoteMachine routes the commit through the awaited path, which keeps the
  // editor open on a stale rejection (the optimistic list path closes it immediately).
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ saveRemoteMachine: vi.fn() } as unknown as ApplicationActions} onMachinesChange={onMachinesChange} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Edit" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "4")
  await user.click(screen.getByRole("button", { name: /save/i }))

  expect(await screen.findByText("This VM changed since you opened it.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Review changes" })).toBeVisible()
  // Still on the detail page, not the list.
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible()
  expect(screen.queryByRole("list", { name: "Configured sandboxes" })).not.toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Review changes" }))
  expect(screen.queryByText("This VM changed since you opened it.")).not.toBeInTheDocument()
})

it("confirms a delete in a dialog on the detail page and returns to the list", async () => {
  const source = localVmSource()
  // A stopped VM so Delete is allowed.
  const workspace = source.workspaces.find(item => item.machine.kind === "vm" && item.state !== "running")
    ?? source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.state = "stopped"
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={onMachinesChange} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${workspace.machine.name}` }))

  // The confirmation is a dialog with the retention warning and a destructive confirm button.
  const dialog = screen.getByRole("dialog")
  expect(within(dialog).getByText(/Persistent volumes will be retained/)).toBeVisible()
  await user.click(within(dialog).getByRole("button", { name: `Delete ${workspace.machine.name}` }))

  expect(onMachinesChange).toHaveBeenCalled()
  expect(await screen.findByRole("list", { name: "Configured sandboxes" })).toBeVisible()
})
