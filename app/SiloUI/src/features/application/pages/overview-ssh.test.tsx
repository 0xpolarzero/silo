import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"
import { NetworkPage } from "./network-page"

it("keeps independent address-copy badges beside the sandbox and expands its controls", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(w => w.machine.kind === "vm")!
  source.sshAccess = { workspaces: [{ workspace: workspace.machine.name, enabled: true, port: 2222, bindAddress: "192.168.1.42", keys: [], state: "listening", message: null, fingerprint: null, computerName: "Ada Mac", addresses: ["127.0.0.1", "192.168.1.42"] }] }
  const actions = { refreshSshAccess: vi.fn().mockResolvedValue(undefined), saveSshAccess: vi.fn(), sshConnection: vi.fn() } as unknown as ApplicationActions
  const user = userEvent.setup()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  const row = within(screen.getByLabelText("Local SSH on Ada Mac").closest("li")!)
  expect(row.getByLabelText("Network SSH on Ada Mac")).toBeVisible()
  expect(row.queryByRole("switch")).not.toBeInTheDocument()
  await user.click(row.getByRole("button", { name: `Copy Local SSH address for ${workspace.machine.name}` }))
  expect(await navigator.clipboard.readText()).toBe("127.0.0.1:2222")
  await user.click(row.getByRole("button", { name: `Copy Network SSH address for ${workspace.machine.name}` }))
  expect(await navigator.clipboard.readText()).toBe("192.168.1.42:2222")
  await user.click(row.getByRole("button", { name: `SSH controls for ${workspace.machine.name}` }))
  expect(row.getAllByRole("switch")).toHaveLength(2)
  expect(row.getByText("127.0.0.1:2222")).toBeVisible()
  expect(row.getByText("192.168.1.42:2222")).toBeVisible()
  await user.click(row.getByRole("button", { name: `SSH controls for ${workspace.machine.name}` }))
  source.sshAccess.workspaces[0].bindAddress = "127.0.0.1"
  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)
  expect(row.getByLabelText("Local SSH on Ada Mac")).toBeVisible()
  expect(row.queryByLabelText("Network SSH on Ada Mac")).not.toBeInTheDocument()
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
  expect(screen.getByText("192.168.1.42:2222")).toBeVisible()
  for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled()
  expect(screen.getByRole("button", { name: "Copy SSH address" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Copy Local SSH address for dev" })).toBeDisabled()
  await user.click(disclosure)
  expect(disclosure).toHaveAttribute("aria-expanded", "false")
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled()
})
