import { render, screen, waitFor, within } from "@testing-library/react"
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
  expect(screen.getByRole("textbox", { name: "Sandbox name" })).toBeVisible()
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
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  // The sandbox is running, so saving asks to stop it first.
  await user.click(screen.getByRole("button", { name: "Stop and save…" }))
  await user.click(screen.getByRole("button", { name: "Stop and save" }))

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
  const onMachinesChange = vi.fn().mockRejectedValue(new Error("This sandbox changed while your edit was waiting. Review it and try again."))
  // A defined saveRemoteMachine routes the commit through the awaited path, which keeps the
  // editor open on a stale rejection (the optimistic list path closes it immediately).
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ saveRemoteMachine: vi.fn() } as unknown as ApplicationActions} onMachinesChange={onMachinesChange} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Edit" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  // The sandbox is running, so saving asks to stop it first.
  await user.click(screen.getByRole("button", { name: "Stop and save…" }))
  await user.click(screen.getByRole("button", { name: "Stop and save" }))

  expect(await screen.findByText("This sandbox changed since you opened it.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Review changes" })).toBeVisible()
  // Still on the detail page, not the list.
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible()
  expect(screen.queryByRole("list", { name: "Configured sandboxes" })).not.toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Review changes" }))
  expect(screen.queryByText("This sandbox changed since you opened it.")).not.toBeInTheDocument()
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

  // Remove requires the same confirmation popover as the Secrets page.
  await user.click(screen.getByRole("button", { name: "Remove SERVICE_TOKEN" }))
  expect(removeSecret).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(removeSecret).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Remove SERVICE_TOKEN" }))
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByText("Remove SERVICE_TOKEN?")).not.toBeInTheDocument())
  expect(removeSecret).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Remove SERVICE_TOKEN" }))
  await user.click(screen.getByRole("button", { name: /^Remove$/ }))
  expect(removeSecret).toHaveBeenCalledExactlyOnceWith("svc")
})

it("never lists a same-named local sandbox's secrets on a remote sandbox page", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  workspace.computer = { id: "office", vmId: workspace.machine.id, name: "Office", address: "office.test", connected: true }
  source.secrets = [{ id: "svc", name: "SERVICE_TOKEN", workspaces: [workspace.machine.name], allowedDomains: [], state: "active" }]
  await openDetail(source, { saveSecret: vi.fn(), removeSecret: vi.fn() }, workspace)

  expect(screen.getByText("Secrets are available only for sandboxes on this computer.")).toBeVisible()
  expect(screen.queryByText("SERVICE_TOKEN")).not.toBeInTheDocument()
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

  expect(screen.getByText("3000 → http://127.0.0.1:43000")).toBeVisible()
  await user.click(screen.getByRole("button", { name: `Open port 3000 in browser` }))
  expect(openNetworkPort).toHaveBeenCalledWith(workspaceTarget(workspace), 3000)
})

it("adds a port fixed to this sandbox from the Overview tab", async () => {
  const source = localVmSource()
  const workspace = localVm(source)
  runningVmWithPort(source, workspace)
  const saveNetworkPort = vi.fn().mockResolvedValue(undefined)
  const { user } = await openDetail(source, { saveNetworkPort, removeNetworkPort: vi.fn(), openNetworkPort: vi.fn(), refreshNetwork: vi.fn(async () => {}) })

  await user.click(screen.getByRole("button", { name: "Add port" }))
  await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9000")
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

it("confirms a delete in a popover on the detail page and returns to the list", async () => {
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

  // The confirmation is a popover anchored to the menu button, not a dialog.
  expect(await screen.findByText(`Delete ${workspace.machine.name} permanently?`)).toBeVisible()
  expect(screen.queryByRole("dialog", { hidden: true })?.getAttribute("aria-modal")).not.toBe("true")
  const popover = within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!)
  expect(popover.getByText(/will be deleted. This can't be undone./)).toBeVisible()
  await user.click(popover.getByRole("button", { name: "Delete permanently" }))

  expect(onMachinesChange).toHaveBeenCalled()
  expect(await screen.findByRole("list", { name: "Configured sandboxes" })).toBeVisible()
})

it("shows a destructive Delete confirmation from the detail ⋯ menu and Fork still opens its own popover", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.state = "stopped"
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ forkCheckpoint: vi.fn() } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${workspace.machine.name}` }))
  expect(await screen.findByText(`Delete ${workspace.machine.name} permanently?`)).toBeVisible()
  const remove = within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name: "Delete permanently" })
  expect(remove.className).toContain("destructive")
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByText(`Delete ${workspace.machine.name} permanently?`)).not.toBeInTheDocument())

  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(await screen.findByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  expect(await screen.findByText(`Fork ${workspace.machine.name}`)).toBeVisible()
  expect(screen.queryByText(`Delete ${workspace.machine.name} permanently?`)).not.toBeInTheDocument()
})

it("does not bring a closed fork popover back when returning to the list", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ forkCheckpoint: vi.fn() } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(await screen.findByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  expect(await screen.findByText(`Fork ${workspace.machine.name}`)).toBeVisible()
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByText(`Fork ${workspace.machine.name}`)).not.toBeInTheDocument())

  await user.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Sandboxes" }))
  expect(screen.getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
  expect(screen.queryByText(`Fork ${workspace.machine.name}`)).not.toBeInTheDocument()
  expect(document.querySelector("[data-slot=popover-content]")).toBeNull()
})

it("does not carry an open fork popover from the detail page to the list", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{ forkCheckpoint: vi.fn() } as unknown as ApplicationActions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(await screen.findByRole("menuitem", { name: `Fork ${workspace.machine.name}` }))
  expect(await screen.findByText(`Fork ${workspace.machine.name}`)).toBeVisible()
  await user.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Sandboxes" }))
  expect(screen.queryByText(`Fork ${workspace.machine.name}`)).not.toBeInTheDocument()
})

it("confirms a delete from the list row ⋯ menu with the same popover as the detail page", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  workspace.state = "stopped"
  const onMachinesChange = vi.fn()
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={onMachinesChange} />)
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(await screen.findByRole("menuitem", { name: `Delete ${workspace.machine.name}` }))
  expect(await screen.findByText(`Delete ${workspace.machine.name} permanently?`)).toBeVisible()
  const popover = within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!)
  // The row states what is lost exactly as the page does, checkpoint count included.
  expect(popover.getByText(`Its files and ${workspace.checkpoints?.length ?? 0} checkpoints will be deleted. This can't be undone.`)).toBeVisible()
  expect(screen.queryByRole("menuitem", { name: /Confirm deletion/ })).not.toBeInTheDocument()
  await user.click(popover.getByRole("button", { name: "Delete permanently" }))
  await waitFor(() => expect(onMachinesChange).toHaveBeenCalled())
})

it("resets per-sandbox edit state when the page switches to another sandbox", async () => {
  const source = localVmSource()
  const [first, second] = source.workspaces.filter(item => item.machine.kind === "vm" && !item.computer)
  const user = userEvent.setup()
  const props = { source, actions: {} as ApplicationActions, onMachinesChange: vi.fn(), onOpenSandbox: vi.fn(), onCloseSandbox: vi.fn() }
  const { rerender } = render(<OverviewPage {...props} selectedSandboxId={first.machine.id} />)

  await user.click(screen.getByRole("button", { name: `More actions for ${first.machine.name}` }))
  await user.click(await screen.findByRole("menuitem", { name: `Edit ${first.machine.name}` }))
  expect(screen.getByRole("heading", { name: `Edit ${first.machine.name}` })).toBeVisible()

  rerender(<OverviewPage {...props} selectedSandboxId={second.machine.id} />)
  expect(screen.queryByRole("heading", { name: `Edit ${second.machine.name}` })).not.toBeInTheDocument()
  expect(screen.queryByRole("heading", { name: `Edit ${first.machine.name}` })).not.toBeInTheDocument()
})
