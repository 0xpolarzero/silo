import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0]!

function renderRunningEditor(running = true) {
  const onMachinesChange = vi.fn()
  const view = (isRunning: boolean) => <TooltipProvider><MachineList machines={[machine]} onMachinesChange={onMachinesChange}
    isMachineCreated={() => true} isMachineRunning={() => isRunning}
    initialEditorDraft={{ draft: machine, originalID: machine.id, insertAt: 0 }} /></TooltipProvider>
  const result = render(view(running))
  return { onMachinesChange, user: userEvent.setup(), rerender: (isRunning: boolean) => result.rerender(view(isRunning)) }
}

describe("saving changes that stop a running sandbox", () => {
  it("confirms the stop inline before saving", async () => {
    const { onMachinesChange, user } = renderRunningEditor()
    await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "4")
    await user.click(screen.getByRole("button", { name: "Stop and save…" }))
    expect(onMachinesChange).not.toHaveBeenCalled()
    const confirmation = screen.getByRole("group", { name: `Stop ${machine.name} and save?` })
    expect(confirmation).toHaveTextContent("Running processes will be interrupted.")
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus()

    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("group", { name: `Stop ${machine.name} and save?` })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Stop and save…" })).toHaveFocus()
    expect(onMachinesChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Stop and save…" }))
    await user.click(screen.getByRole("button", { name: "Stop and save" }))
    expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith([{ ...machine, cpus: 4 }])
  })

  it("dismisses the confirmation with Escape without saving", async () => {
    const { onMachinesChange, user } = renderRunningEditor()
    await user.click(screen.getByRole("button", { name: "Stop and save…" }))
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("group", { name: `Stop ${machine.name} and save?` })).not.toBeInTheDocument()
    expect(onMachinesChange).not.toHaveBeenCalled()
  })

  it("saves without asking once the sandbox has stopped", async () => {
    const { onMachinesChange, user, rerender } = renderRunningEditor()
    await user.click(screen.getByRole("button", { name: "Stop and save…" }))
    rerender(false)
    expect(screen.queryByRole("group", { name: `Stop ${machine.name} and save?` })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange).toHaveBeenCalledOnce()
  })
})
