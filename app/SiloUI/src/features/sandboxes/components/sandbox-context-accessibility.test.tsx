import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { ComputerBadge } from "./computer-badge"
import { MachineList } from "./machine-list"

it("exposes the focusable computer badge as a named note with connection context", async () => {
  const user = userEvent.setup()
  render(<ComputerBadge computer={{ id: "office", name: "Office", address: "office.example", connected: false, vmId: "dev" }} />)
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
