import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { sandboxBusyReason } from "@/features/sandboxes/model/workspace-presentation"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0]!
const starting = `Wait until ${machine.name} finishes starting.`

describe("sandboxes that are starting or stopping", () => {
  it("explains why a starting, stopping or restarting VM cannot be changed", () => {
    const workspace = { ...applicationSourceForScenario("complete").workspaces[0]!, machine }
    expect(sandboxBusyReason({ ...workspace, state: "starting" })).toBe(starting)
    expect(sandboxBusyReason({ ...workspace, state: "running", lifecycleAction: "stop" })).toBe(`Wait until ${machine.name} finishes stopping.`)
    expect(sandboxBusyReason({ ...workspace, state: "running", lifecycleAction: "restart" })).toBe(`Wait until ${machine.name} finishes restarting.`)
    expect(sandboxBusyReason({ ...workspace, state: "running", lifecycleAction: undefined })).toBeUndefined()
    expect(sandboxBusyReason({ ...workspace, state: "failed", lifecycleAction: undefined })).toBeUndefined()
  })

  it("does not offer Edit, Add Linux desktop or Delete for a starting VM", async () => {
    render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} isMachineCreated={() => true}
      isMachineRunning={() => false} getMachineBusyReason={() => starting} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
    await userEvent.setup().click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
    for (const name of [`Edit ${machine.name}`, "Add Linux desktop", `Delete ${machine.name}`]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true")
    }
    // The reason is announced on the disabled items' focusable wrappers.
    expect(screen.getAllByLabelText(starting).length).toBeGreaterThanOrEqual(3)
    expect(screen.getByRole("menuitem", { name: `Duplicate ${machine.name}` })).not.toHaveAttribute("aria-disabled")
  })

  it("blocks Save with the reason when an open editor's VM starts", () => {
    const view = (busy?: string) => <TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} isMachineCreated={() => true}
      isMachineRunning={() => false} getMachineBusyReason={() => busy}
      initialEditorDraft={{ draft: machine, originalID: machine.id, insertAt: 0 }} /></TooltipProvider>
    const { rerender } = render(view())
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    rerender(view(starting))
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save" })).toHaveAccessibleDescription(starting)
  })
})
