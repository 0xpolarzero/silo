import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace } from "../model/application-source"
import { workspaceTarget } from "../model/remote-computers"
import { OverviewPage } from "./overview-page"

function localVmSource() {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  return source
}

function localVm(source: ApplicationSource): ApplicationWorkspace {
  return source.workspaces.find(item => item.machine.kind === "vm" && !item.computer)!
}

async function openDetail(source: ApplicationSource, actions: Partial<ApplicationActions> = {}, workspace = localVm(source)) {
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions as ApplicationActions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  return { user, workspace }
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

it("adds a secret from the Overview tab preselected to this sandbox", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  source.secrets = []
  const saveSecret = vi.fn().mockResolvedValue(undefined)
  const { user } = await openDetail(source, { saveSecret, removeSecret: vi.fn() })

  await user.click(screen.getByRole("button", { name: "Add secret" }))
  const form = within(screen.getByRole("form", { name: "Add secret" }))
  // The sandbox is preselected, so its removal chip is already present.
  expect(form.getByRole("button", { name: `Remove ${workspace.machine.name}` })).toBeVisible()
  await user.type(form.getByRole("textbox", { name: "Name" }), "SERVICE_TOKEN")
  await user.type(form.getByLabelText("Value"), "fixture-token")
  await user.type(form.getByRole("textbox", { name: "Allowed domains" }), "api.example.test")
  await user.click(form.getByRole("button", { name: "Save" }))

  expect(saveSecret).toHaveBeenCalledExactlyOnceWith({ operation: "add", name: "SERVICE_TOKEN", value: "fixture-token", workspaces: [workspace.machine.name], allowedDomains: ["api.example.test"] })
})

it("edits and removes a sandbox's secret from the Overview tab", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  source.secrets = [{ id: "svc", name: "SERVICE_TOKEN", workspaces: [workspace.machine.name], allowedDomains: ["api.example.test"], state: "active" }]
  const saveSecret = vi.fn().mockResolvedValue(undefined)
  const removeSecret = vi.fn().mockResolvedValue(undefined)
  const { user } = await openDetail(source, { saveSecret, removeSecret })

  // Edit routes through the shared inline editor and the edit save path.
  await user.click(screen.getByRole("button", { name: "Edit SERVICE_TOKEN" }))
  const form = within(screen.getByRole("form", { name: "Edit SERVICE_TOKEN" }))
  await user.type(form.getByLabelText("Replacement value"), "rotated")
  await user.click(form.getByRole("button", { name: "Save" }))
  expect(saveSecret).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "edit", id: "svc", value: "rotated" }))

  // Remove requires the same inline confirmation as the Secrets page.
  await user.click(screen.getByRole("button", { name: "Remove SERVICE_TOKEN" }))
  expect(removeSecret).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Confirm removal of SERVICE_TOKEN" }))
  expect(removeSecret).toHaveBeenCalledExactlyOnceWith("svc")
})

it("keeps a remote computer's secrets read-only on the Overview tab", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  workspace.computer = { id: "office", vmId: workspace.machine.id, name: "Office", address: "office.test", connected: true }
  source.secrets = [{ id: "svc", name: "SERVICE_TOKEN", workspaces: [workspace.machine.name], allowedDomains: [], state: "active" }]
  await openDetail(source, { saveSecret: vi.fn(), removeSecret: vi.fn() }, workspace)

  expect(screen.getByText("SERVICE_TOKEN")).toBeVisible()
  expect(screen.queryByRole("button", { name: "Add secret" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Edit SERVICE_TOKEN" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Remove SERVICE_TOKEN" })).not.toBeInTheDocument()
})

function runningVmWithPort(source: ApplicationSource, workspace: ApplicationWorkspace) {
  workspace.state = "running"
  workspace.freshness = "fresh"
  source.network = { workspaces: [{ workspace: workspaceTarget(workspace), error: null, ports: [
    { port: 3000, hostPort: 43000, scheme: "http", state: "reachable", configured: true },
  ] }] }
}

it("reflects live network data and opens a reachable port from the Overview tab", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  runningVmWithPort(source, workspace)
  const openNetworkPort = vi.fn().mockResolvedValue(undefined)
  const { user } = await openDetail(source, { openNetworkPort, saveNetworkPort: vi.fn(), removeNetworkPort: vi.fn(), refreshNetwork: vi.fn(async () => {}) })

  expect(screen.getByText("http://127.0.0.1:43000")).toBeVisible()
  await user.click(screen.getByRole("button", { name: `Open http://127.0.0.1:43000 in ${source.preferences.browser}` }))
  expect(openNetworkPort).toHaveBeenCalledWith(workspaceTarget(workspace), 3000)
})

it("adds a port fixed to this sandbox from the Overview tab", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  runningVmWithPort(source, workspace)
  const saveNetworkPort = vi.fn().mockResolvedValue(undefined)
  const { user } = await openDetail(source, { saveNetworkPort, removeNetworkPort: vi.fn(), openNetworkPort: vi.fn(), refreshNetwork: vi.fn(async () => {}) })

  await user.click(screen.getByRole("button", { name: "Add port" }))
  await user.type(screen.getByRole("spinbutton", { name: "VM port" }), "9000")
  await user.click(screen.getByRole("button", { name: "Add" }))
  expect(saveNetworkPort).toHaveBeenCalledWith({ workspace: workspaceTarget(workspace), port: 9000, hostPort: null, scheme: "http" })
})

it("confirms before removing a port from the Overview tab", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  runningVmWithPort(source, workspace)
  const removeNetworkPort = vi.fn().mockResolvedValue(undefined)
  const { user } = await openDetail(source, { saveNetworkPort: vi.fn(), removeNetworkPort, openNetworkPort: vi.fn(), refreshNetwork: vi.fn(async () => {}) })

  await user.click(screen.getByRole("button", { name: `Remove port 3000 from ${workspace.machine.name}` }))
  expect(removeNetworkPort).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Remove" }))
  expect(removeNetworkPort).toHaveBeenCalledWith(workspaceTarget(workspace), 3000)
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
