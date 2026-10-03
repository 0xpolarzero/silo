import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { SetupVirtualMachineConfiguration } from "@/contracts/silo"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0] as SetupVirtualMachineConfiguration

describe("remote saves use the editing baseline", () => {
  it("sends the values the editor opened with as the expected state", async () => {
    const commit = vi.fn().mockResolvedValue(undefined)
    const list = (machines: SetupVirtualMachineConfiguration[]) => <TooltipProvider><MachineList machines={machines} onMachinesChange={vi.fn()} onCommitMachine={commit}
      getDeviceId={() => "office"} isMachineCreated={() => true} isMachineRunning={() => false}
      getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>
    const { rerender } = render(list([machine]))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
    await user.click(screen.getByRole("menuitem", { name: /^Edit/ }))
    const changedElsewhere = { ...machine, cpus: machine.cpus === 2 ? 4 : 2 }
    rerender(list([changedElsewhere]))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![1]).toEqual(machine)
  })
})
