import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "./machine-list"

it("blocks an armed deletion if the VM starts before confirmation", async () => {
  const machine = productionMachineDefaults[0]
  const save = vi.fn()
  const view = (running: boolean) => <TooltipProvider><MachineList machines={[machine]} onMachinesChange={save} isMachineRunning={() => running} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>
  const { rerender } = render(view(false))
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Delete ${machine.name}` }))
  rerender(view(true))
  const confirm = screen.getByRole("menuitem", { name: `Confirm deletion of ${machine.name}` })
  expect(confirm).toHaveAttribute("aria-disabled", "true")
  await user.click(confirm.parentElement!)
  expect(save).not.toHaveBeenCalled()
  rerender(view(false))
  await user.click(screen.getByRole("menuitem", { name: `Confirm deletion of ${machine.name}` }))
  expect(save).toHaveBeenCalledWith([])
})
