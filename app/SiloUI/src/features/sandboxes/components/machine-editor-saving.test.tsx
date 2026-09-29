import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
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
    await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "2")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "CPU limit" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Memory limit" })).toBeDisabled()
  })
})
