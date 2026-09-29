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

it("runs Edit from the detail menu by reopening the sandbox editor in the list", async () => {
  const source = localVmSource()
  const workspace = source.workspaces.find(item => item.machine.kind === "vm")!
  const user = userEvent.setup()
  render(<OverviewPage source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} />)

  await user.click(screen.getByRole("button", { name: `Open ${workspace.machine.name}` }))
  await user.click(screen.getByRole("button", { name: `More actions for ${workspace.machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${workspace.machine.name}` }))
  expect(screen.getByRole("textbox", { name: "Machine name" })).toBeVisible()
})
