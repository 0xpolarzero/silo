import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { DeviceBadge } from "./device-badge"
import { MachineList } from "./machine-list"
import { SandboxListRow } from "./sandbox-list"

it("exposes the sandbox's management and runtime controls as named groups", () => {
  render(<SandboxListRow name="dev" kind="vm" detail="Stopped"
    hoverActions={<button type="button">Edit dev</button>}
    actions={<button type="button">Start dev</button>} />)
  expect(within(screen.getByRole("group", { name: "Manage dev" })).getByRole("button", { name: "Edit dev" })).toBeVisible()
  expect(within(screen.getByRole("group", { name: "Controls for dev" })).getByRole("button", { name: "Start dev" })).toBeVisible()
})

it("names each sandbox list group with its own heading", () => {
  render(<TooltipProvider>
    <MachineList machines={[]} onMachinesChange={vi.fn()} />
    <MachineList machines={[]} onMachinesChange={vi.fn()} />
  </TooltipProvider>)
  const groups = screen.getAllByRole("group", { name: "Sandboxes" })
  expect(groups).toHaveLength(2)
  expect(new Set(groups.map(group => group.getAttribute("aria-labelledby"))).size).toBe(2)
  for (const group of groups) {
    const heading = within(group).getByRole("heading", { name: "Sandboxes" })
    expect(group).toHaveAttribute("aria-labelledby", heading.id)
    expect(within(group).getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
  }
})

it("exposes the focusable device badge as a named note with connection context", async () => {
  const user = userEvent.setup()
  render(<DeviceBadge device={{ id: "office", name: "Office", address: "office.example", connected: false, vmId: "dev" }} />)
  const note = screen.getByRole("note", { name: "Sandbox on Office · Offline · last known status · office.example" })
  await user.tab()
  expect(note).toHaveFocus()
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Office · Offline · last known status · office.example")
})

it("names the focusable read-only disk groups and keeps their values available", async () => {
  const machine = productionMachineDefaults[0]
  if (machine.kind !== "vm") throw new Error("Expected a sandbox fixture")
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} isMachineCreated={() => true} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `Edit ${machine.name}` }))
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Sandbox name" })).toHaveFocus())
  for (const label of ["CPUs", "CPUs ceiling", "Memory", "Memory ceiling"]) {
    await user.tab()
    expect(screen.getByRole("combobox", { name: label })).toHaveFocus()
  }
  for (const [label, value] of [["Workspace disk", machine.workspaceStorageGiB], ["Runtime disk", machine.runtimeStorageGiB]] as const) {
    const group = screen.getByRole("group", { name: `${label}: ${value} GiB, read-only` })
    expect(within(group).getByRole("combobox", { name: label })).toBeDisabled()
    await user.tab()
    expect(group).toHaveFocus()
  }
})
