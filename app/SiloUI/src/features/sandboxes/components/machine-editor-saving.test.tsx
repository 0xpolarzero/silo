import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0]!

describe("machine editor while saving", () => {
  it("locks every field until the save settles", async () => {
    const pending = () => new Promise<void>(() => {})
    render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={pending} onCommitMachine={pending}
      isMachineCreated={() => true} isMachineRunning={() => false}
      initialEditorDraft={{ draft: machine, originalID: machine.id, insertAt: 0 }} /></TooltipProvider>)
    const user = userEvent.setup()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "2")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent(`Saving ${machine.name}…`)
    expect(screen.getByRole("combobox", { name: "CPUs" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Memory" })).toBeDisabled()
  })

  it("disables Save with a reason when another change locks editing after the editor opened", async () => {
    const onMachinesChange = vi.fn()
    const view = (interactionDisabled: boolean) => <TooltipProvider><MachineList machines={[machine]} onMachinesChange={onMachinesChange}
      isMachineCreated={() => true} isMachineRunning={() => false} interactionDisabled={interactionDisabled}
      initialEditorDraft={{ draft: machine, originalID: machine.id, insertAt: 0 }} /></TooltipProvider>
    const { rerender } = render(view(false))
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "2")
    rerender(view(true))
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()
    expect(save).toHaveAccessibleDescription("Saving is paused while another sandbox change is in progress or needs review.")
    // The draft is kept, so Save works again once the lock clears.
    rerender(view(false))
    expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("2")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange.mock.lastCall?.[0]).toEqual([expect.objectContaining({ cpus: 2 })])
  })
})
