import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { SetupComputerConfiguration } from "@/contracts/silo"
import { productionComputerDefaults } from "@/features/onboarding/model/computer-configuration"
import { ComputerConfigurationList } from "./computer-configuration-list"

const configuration = productionComputerDefaults[0] as SetupComputerConfiguration

describe("remote saves use the editing baseline", () => {
  it("sends the values the editor opened with as the expected state", async () => {
    const commit = vi.fn().mockResolvedValue(undefined)
    const list = (configurations: SetupComputerConfiguration[]) => <TooltipProvider><ComputerConfigurationList configurations={configurations} onConfigurationsChange={vi.fn()} onCommitComputer={commit}
      getDeviceId={() => "office"} isComputerCreated={() => true} isComputerRunning={() => false}
      getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>
    const { rerender } = render(list([configuration]))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: `More actions for ${configuration.name}` }))
    await user.click(screen.getByRole("menuitem", { name: /^Edit/ }))
    const changedElsewhere = { ...configuration, cpus: configuration.cpus === 2 ? 4 : 2 }
    rerender(list([changedElsewhere]))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![1]).toEqual(configuration)
  })
})
