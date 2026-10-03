import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { productionComputerDefaults } from "@/features/onboarding/model/computer-configuration"
import { computerBusyReason } from "@/features/computers/model/computer-presentation"
import { ComputerConfigurationList } from "./computer-configuration-list"

const configuration = productionComputerDefaults[0]!
const starting = `Wait until ${configuration.name} finishes starting.`

describe("computers that are starting or stopping", () => {
  it("explains why a starting, stopping or restarting computer cannot be changed", () => {
    const computer = { ...applicationSourceForScenario("complete").computers[0]!, configuration }
    expect(computerBusyReason({ ...computer, state: "starting" })).toBe(starting)
    expect(computerBusyReason({ ...computer, state: "running", lifecycleAction: "stop" })).toBe(`Wait until ${configuration.name} finishes stopping.`)
    expect(computerBusyReason({ ...computer, state: "running", lifecycleAction: "restart" })).toBe(`Wait until ${configuration.name} finishes restarting.`)
    expect(computerBusyReason({ ...computer, state: "running", lifecycleAction: undefined })).toBeUndefined()
    expect(computerBusyReason({ ...computer, state: "failed", lifecycleAction: undefined })).toBeUndefined()
  })

  it("does not offer Edit, Add Linux desktop or Delete for a starting computer", async () => {
    render(<TooltipProvider><ComputerConfigurationList configurations={[configuration]} onConfigurationsChange={vi.fn()} isComputerCreated={() => true}
      isComputerRunning={() => false} getConfigurationBusyReason={() => starting} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
    await userEvent.setup().click(screen.getByRole("button", { name: `More actions for ${configuration.name}` }))
    for (const name of [`Edit ${configuration.name}`, "Add Linux desktop", `Delete ${configuration.name}`]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true")
    }
    // The reason is announced on the disabled items' focusable wrappers.
    expect(screen.getAllByLabelText(starting).length).toBeGreaterThanOrEqual(3)
    expect(screen.getByRole("menuitem", { name: `Duplicate settings for ${configuration.name}` })).not.toHaveAttribute("aria-disabled")
  })

  it("blocks Save with the reason when an open editor's computer starts", () => {
    const view = (busy?: string) => <TooltipProvider><ComputerConfigurationList configurations={[configuration]} onConfigurationsChange={vi.fn()} isComputerCreated={() => true}
      isComputerRunning={() => false} getConfigurationBusyReason={() => busy}
      initialEditorDraft={{ draft: configuration, originalID: configuration.id, insertAt: 0 }} /></TooltipProvider>
    const { rerender } = render(view())
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    rerender(view(starting))
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save" })).toHaveAccessibleDescription(starting)
  })
})
