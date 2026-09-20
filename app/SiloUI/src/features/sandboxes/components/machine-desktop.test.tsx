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
  it("installs from the sandbox menu while preserving its configuration", async () => {
    const save = vi.fn()
    render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={save}
      isMachineCreated={() => true} isMachineRunning={() => true}
      getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
    await user.click(screen.getByRole("menuitem", { name: "Add Linux desktop" }))
    expect(save).toHaveBeenCalledWith([{ ...machine, desktop: { startWithSandbox: true } }])
  })
  it("routes menu installation to the owning computer and surfaces failures", async () => {
    const save = vi.fn().mockRejectedValue(new Error("Computer disconnected"))
    const localSave = vi.fn()
    render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={localSave}
      onCommitMachine={save} getComputerId={() => "remote-computer"}
      isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
    await user.click(screen.getByRole("menuitem", { name: "Add Linux desktop" }))
    expect(save).toHaveBeenCalledWith({ ...machine, desktop: { startWithSandbox: true } }, machine, "remote-computer")
    expect(await screen.findByRole("alert")).toHaveTextContent("Computer disconnected")
    expect(localSave).not.toHaveBeenCalled()
  })
  it("does not offer installation when the desktop is already configured", async () => {
    render(<TooltipProvider><MachineList machines={[{ ...machine, desktop: { startWithSandbox: true } }]}
      onMachinesChange={vi.fn()} isMachineCreated={() => true}
      getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
    await userEvent.setup().click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
    expect(screen.queryByRole("menuitem", { name: "Add Linux desktop" })).not.toBeInTheDocument()
  })
  it("respects configuration locks", async () => {
    render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()}
      interactionDisabled isMachineCreated={() => true}
      getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
    await userEvent.setup().click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
    expect(screen.getByRole("menuitem", { name: "Add Linux desktop" })).toHaveAttribute("aria-disabled", "true")
  })
  it("checks operation eligibility before installing", async () => {
    const save = vi.fn()
    const validate = vi.fn().mockReturnValue("This computer is unavailable.")
    render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={save}
      validateOperation={validate} isMachineCreated={() => true}
      getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
    await user.click(screen.getByRole("menuitem", { name: "Add Linux desktop" }))
    expect(validate).toHaveBeenCalledWith({ ...machine, desktop: { startWithSandbox: true } }, false, "")
    expect(screen.getByRole("alert")).toHaveTextContent("This computer is unavailable.")
    expect(save).not.toHaveBeenCalled()
  })
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
