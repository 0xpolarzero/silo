import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "./machine-list"

function popoverButton(name: string) { return within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!).getByRole("button", { name }) }

it("confirms a row deletion in a popover anchored to the ⋯ menu", async () => {
  const machine = productionMachineDefaults[0]
  const save = vi.fn()
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={save} isMachineRunning={() => false} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${machine.name}` }))
  expect(await screen.findByText(`Delete ${machine.name}?`)).toBeVisible()
  expect(screen.getByText(`Removing ${machine.name} from Silo. Persistent volumes are kept.`)).toBeVisible()
  expect(save).not.toHaveBeenCalled()
  await user.click(popoverButton("Delete"))
  await waitFor(() => expect(save).toHaveBeenCalledWith([], [machine]))
})

it("cancelling the popover deletes nothing", async () => {
  const machine = productionMachineDefaults[0]
  const save = vi.fn()
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={save} isMachineRunning={() => false} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${machine.name}` }))
  await user.click(await screen.findByRole("button", { name: "Cancel" }))
  expect(save).not.toHaveBeenCalled()
  expect(screen.queryByText(`Delete ${machine.name}?`)).not.toBeInTheDocument()
})

it("blocks a deletion if the VM starts before confirmation", async () => {
  const machine = productionMachineDefaults[0]
  const save = vi.fn()
  const view = (running: boolean) => <TooltipProvider><MachineList machines={[machine]} onMachinesChange={save} isMachineRunning={() => running} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>
  const { rerender } = render(view(false))
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${machine.name}` }))
  await screen.findByText(`Delete ${machine.name}?`)
  rerender(view(true))
  await user.click(popoverButton("Delete"))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(save).not.toHaveBeenCalled()
})
