import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"
import { ConnectionIcon } from "@/components/connection-icon"
import { SshAccessBadges } from "./ssh-access-panel"
import { NetworkPage } from "./network-page"

it("shows one SSH scope badge and keeps both addresses in expanded controls", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(w => w.machine.kind === "vm")!
  source.sshAccess = { workspaces: [{ workspace: workspace.machine.name, enabled: true, port: 2222, bindAddress: "192.168.1.42", keys: [], state: "listening", message: null, fingerprint: null, computerName: "Ada Mac", addresses: ["127.0.0.1", "192.168.1.42"] }] }
  const actions = { refreshSshAccess: vi.fn().mockResolvedValue(undefined), saveSshAccess: vi.fn(), sshConnection: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByLabelText("SSH from Ada Mac and other computers").closest("li")!)
  expect(row.getByLabelText("SSH from Ada Mac and other computers")).toBeVisible()
  expect(row.queryByRole("switch")).not.toBeInTheDocument()
  expect(row.queryByLabelText("SSH from Ada Mac only")).not.toBeInTheDocument()
  await user.click(row.getByRole("button", { name: `SSH controls for ${workspace.machine.name}` }))
  expect(row.getAllByRole("switch")).toHaveLength(2)
  expect(row.getByText("root@127.0.0.1:2222")).toBeVisible()
  expect(row.getByText("root@192.168.1.42:2222")).toBeVisible()
  await user.click(row.getByRole("button", { name: "Copy SSH address" }))
  expect(await navigator.clipboard.readText()).toBe("root@127.0.0.1:2222")
  await user.click(row.getByRole("button", { name: "Copy network SSH address" }))
  expect(await navigator.clipboard.readText()).toBe("root@192.168.1.42:2222")
  await user.click(row.getByRole("button", { name: `SSH controls for ${workspace.machine.name}` }))
  source.sshAccess.workspaces[0].bindAddress = "127.0.0.1"
  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  expect(row.getByLabelText("SSH from Ada Mac only")).toBeVisible()
  expect(row.queryByLabelText("SSH from Ada Mac and other computers")).not.toBeInTheDocument()
})

it("keeps Network limited to service ports", () => {
  const source = applicationSourceForScenario("complete")
  render(<NetworkPage workspaces={source.workspaces} browser="Safari" actions={{ refreshSshAccess: vi.fn() } as unknown as ApplicationActions} active />)
  expect(screen.getByRole("button", { name: "Add port" })).toBeVisible()
  expect(screen.queryByRole("button", { name: /SSH controls/ })).not.toBeInTheDocument()
})

it("allows read-only SSH disclosure without refreshing, copying, or changing the sandbox", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.sshAccess = { workspaces: [{ workspace: "dev", enabled: true, port: 2222, bindAddress: "192.168.1.42", keys: [], state: "listening", message: null, fingerprint: null, computerName: "This computer", addresses: ["127.0.0.1", "192.168.1.42"] }] }
  const actions = { refreshSshAccess: vi.fn(), saveSshAccess: vi.fn(), sshConnection: vi.fn(), openTerminal: vi.fn(), stopWorkspace: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<OverviewPage readOnly source={source} actions={actions} onMachinesChange={vi.fn()} />)
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Stop dev" })).toBeDisabled()
  const disclosure = screen.getByRole("button", { name: "SSH controls for dev" })
  await user.click(disclosure)
  expect(disclosure).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText("root@192.168.1.42:2222")).toBeVisible()
  for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled()
  expect(screen.getByRole("button", { name: "Copy SSH address" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Copy network SSH address" })).toBeDisabled()
  await user.click(disclosure)
  expect(disclosure).toHaveAttribute("aria-expanded", "false")
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
