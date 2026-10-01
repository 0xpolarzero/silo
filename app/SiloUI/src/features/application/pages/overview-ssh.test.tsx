import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"
import { ConnectionIcon } from "@/components/connection-icon"
import { SshAccessBadges } from "./ssh-access-panel"
import { NetworkPage } from "./network-page"

it("surfaces both SSH addresses and the scope badge on the sandbox SSH tab", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(w => w.machine.kind === "vm")!
  source.sshAccess = { workspaces: [{ workspace: workspace.machine.name, enabled: true, port: 2222, bindAddress: "192.168.1.42", keys: [], state: "listening", message: null, fingerprint: null, computerName: "Ada Mac", addresses: ["127.0.0.1", "192.168.1.42"] }] }
  const actions = { refreshSshAccess: vi.fn().mockResolvedValue(undefined), saveSshAccess: vi.fn(), sshConnection: vi.fn(), openTerminal: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  // The list row keeps a single scope badge and no inline SSH access controls.
  const row = within(screen.getByLabelText("SSH from Ada Mac and other computers").closest("li")!)
  expect(row.queryByRole("switch")).not.toBeInTheDocument()
  expect(row.queryByRole("button", { name: /SSH access controls/ })).not.toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("tab", { name: "SSH" }))
  expect(screen.getAllByRole("switch")).toHaveLength(2)
  expect(screen.getByText("ssh -p 2222 silo@127.0.0.1")).toBeVisible()
  expect(screen.getByText("ssh -p 2222 silo@192.168.1.42")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Copy SSH address" }))
  expect(await navigator.clipboard.readText()).toBe("ssh -p 2222 silo@127.0.0.1")
  await user.click(screen.getByRole("button", { name: "Copy network SSH address" }))
  expect(await navigator.clipboard.readText()).toBe("ssh -p 2222 silo@192.168.1.42")

  // The detail subtitle reflects that SSH is enabled without a separate scope chip;
  // the network/local scope stays visible in the SSH tab controls above.
  const refreshed = {
    ...source,
    sshAccess: { ...source.sshAccess, workspaces: source.sshAccess.workspaces.map(access => ({ ...access, bindAddress: "127.0.0.1" })) },
  }
  view.rerender(<OverviewPage source={refreshed} actions={actions} onMachinesChange={vi.fn()} />)
  expect(within(screen.getByRole("navigation", { name: "Breadcrumb" }).parentElement!).getByLabelText(/^SSH from .* only$/)).toBeVisible()
})

it("opens the sandbox's SSH tab from the SSH badge in the list and on the sandbox page", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(w => w.machine.kind === "vm")!
  source.sshAccess = { workspaces: [{ workspace: workspace.machine.name, enabled: true, port: 2222, bindAddress: "10.211.55.2", keys: [], state: "error", message: "The selected network address is unavailable. Choose an active interface.", fingerprint: null, computerName: "Ada Mac", addresses: ["127.0.0.1"] }] }
  const actions = { refreshSshAccess: vi.fn().mockResolvedValue(undefined), saveSshAccess: vi.fn(), sshConnection: vi.fn(), openTerminal: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  await user.click(within(screen.getByRole("list", { name: "Configured sandboxes" })).getByRole("button", { name: /^SSH from Ada Mac/ }))
  expect(screen.getByRole("tab", { name: "SSH" })).toHaveAttribute("aria-selected", "true")

  await user.click(screen.getByRole("tab", { name: "Overview" }))
  await user.click(within(screen.getByRole("navigation", { name: "Breadcrumb" }).parentElement!).getByRole("button", { name: /^SSH from Ada Mac/ }))
  expect(screen.getByRole("tab", { name: "SSH" })).toHaveAttribute("aria-selected", "true")
})

it("opens the SSH tab from the sandbox menu, after Storage", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(w => w.machine.kind === "vm")!
  const actions = { refreshSshAccess: vi.fn().mockResolvedValue(undefined), readWorkspaceStorage: vi.fn().mockResolvedValue(null), saveSshAccess: vi.fn(), sshConnection: vi.fn(), openTerminal: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  const items = screen.getAllByRole("menuitem").map(item => item.getAttribute("aria-label") ?? item.textContent)
  expect(items.indexOf(`SSH for ${workspace.machine.name}`)).toBe(items.indexOf(`Storage for ${workspace.machine.name}`) + 1)
  await user.click(screen.getByRole("menuitem", { name: `SSH for ${workspace.machine.name}` }))
  expect(screen.getByRole("tab", { name: "SSH" })).toHaveAttribute("aria-selected", "true")
})

it("keeps Network limited to service ports", () => {
  const source = applicationSourceForScenario("complete")
  render(<NetworkPage workspaces={source.workspaces} browser="Safari" actions={{ refreshSshAccess: vi.fn() } as unknown as ApplicationActions} active />)
  expect(screen.getByRole("button", { name: "Add port" })).toBeVisible()
  expect(screen.queryByRole("button", { name: /SSH access controls/ })).not.toBeInTheDocument()
})

it("allows read-only SSH disclosure without refreshing, copying, or changing the sandbox", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.sshAccess = { workspaces: [{ workspace: "dev", enabled: true, port: 2222, bindAddress: "192.168.1.42", keys: [], state: "listening", message: null, fingerprint: null, computerName: "This computer", addresses: ["127.0.0.1", "192.168.1.42"] }] }
  const actions = { refreshSshAccess: vi.fn(), saveSshAccess: vi.fn(), sshConnection: vi.fn(), openTerminal: vi.fn(), stopWorkspace: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<OverviewPage readOnly source={source} actions={actions} onMachinesChange={vi.fn()} />)
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Stop dev" })).toBeDisabled()
  await user.click(screen.getByRole("button", { name: "Open dev" }))
  await user.click(screen.getByRole("tab", { name: "SSH" }))
  expect(screen.getByText("ssh -p 2222 silo@192.168.1.42")).toBeVisible()
  for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled()
  expect(screen.getByRole("button", { name: "Copy SSH address" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Copy network SSH address" })).toBeDisabled()
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled()
})


it.each([
  [false, "off"], [false, "host"], [false, "network"],
  [true, "off"], [true, "host"], [true, "network"],
] as const)("communicates remote=%s with SSH scope=%s", (remote, scope) => {
  const host = remote ? "Office Mac" : "This computer"
  const { container } = render(<>
    <ConnectionIcon kind="vm" network={remote} label={remote ? "Remote VM" : "Local VM"} />
    <SshAccessBadges access={{ workspace: "dev", enabled: scope !== "off", port: 2222, bindAddress: scope === "network" ? "192.168.1.42" : "127.0.0.1", keys: [], state: "listening", message: null, fingerprint: null, computerName: host, addresses: [] }} />
  </>)
  expect(screen.getByRole("img", { name: remote ? "Remote VM" : "Local VM" })).toBeVisible()
  expect(container.querySelector(remote ? ".lucide-server" : ".lucide-monitor")).toBeInTheDocument()
  if (scope === "off") expect(screen.queryByText("SSH")).not.toBeInTheDocument()
  else {
    expect(screen.getAllByText("SSH")).toHaveLength(1)
    expect(screen.getByLabelText(`SSH from ${host}${scope === "network" ? " and other computers" : " only"}`)).toBeVisible()
  }
  expect(container.querySelectorAll(".lucide-network")).toHaveLength(scope === "network" ? 1 : 0)
})
