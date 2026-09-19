import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import type { SetupVirtualMachineConfiguration } from "@/contracts/silo"
import { setupMachineConfigurationRequestSchema } from "@/contracts/silo"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0]
function editor(draft: SetupVirtualMachineConfiguration, created: boolean) {
  const save = vi.fn()
  render(<TooltipProvider><MachineList machines={created ? [draft] : []} onMachinesChange={save}
    isMachineCreated={() => created} isMachineRunning={() => created}
    initialEditorDraft={{ draft, originalID: created ? draft.id : undefined, insertAt: 0 }} /></TooltipProvider>)
  return save
}

describe("optional Linux desktop", () => {
  it("keeps legacy configurations desktop-free and retains an explicit startup policy", () => {
    expect(setupMachineConfigurationRequestSchema.parse({ schemaVersion: 1, machines: [machine] }).machines[0]).not.toHaveProperty("desktop")
    expect(setupMachineConfigurationRequestSchema.parse({ schemaVersion: 1, machines: [{ ...machine, desktop: { startWithSandbox: false } }] }).machines[0]).toMatchObject({ desktop: { startWithSandbox: false } })
  })
  it("opts in during creation with automatic startup", async () => {
    const user = userEvent.setup()
    const save = editor(machine, false)
    expect(screen.getByRole("checkbox", { name: "Linux desktop" })).not.toBeChecked()
    await user.click(screen.getByRole("checkbox", { name: "Linux desktop" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(save).toHaveBeenCalledWith([expect.objectContaining({ desktop: { startWithSandbox: true } })])
  })
  it("adds a desktop to a running sandbox without asking to stop it", async () => {
    const user = userEvent.setup()
    const save = editor(machine, true)
    await user.click(screen.getByRole("button", { name: "Add desktop" }))
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(save).toHaveBeenCalledWith([expect.objectContaining({ desktop: { startWithSandbox: true } })])
  })
  it("changes startup policy without offering desktop removal or stopping the VM", async () => {
    const user = userEvent.setup()
    const save = editor({ ...machine, desktop: { startWithSandbox: true } }, true)
    expect(screen.queryByRole("button", { name: "Add desktop" })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    await user.click(screen.getByRole("switch", { name: "Start desktop with sandbox" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(save).toHaveBeenCalledWith([expect.objectContaining({ desktop: { startWithSandbox: false } })])
  })
  it("still explains the VM stop required by a resource change", async () => {
    const user = userEvent.setup()
    editor({ ...machine, desktop: { startWithSandbox: true } }, true)
    await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "4")
    expect(screen.getByRole("button", { name: "Stop VM and save" })).toBeVisible()
  })
})
