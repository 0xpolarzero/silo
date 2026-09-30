import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MachineList } from "./machine-list"

async function openNewSandbox() {
  const onMachinesChange = vi.fn()
  render(<TooltipProvider><MachineList machines={[]} onMachinesChange={onMachinesChange} /></TooltipProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  return { user, onMachinesChange }
}

describe("machine editor validation", () => {
  it("links each error to its field and moves focus to the first invalid field", async () => {
    const { user, onMachinesChange } = await openNewSandbox()
    const name = screen.getByRole("textbox", { name: "Sandbox name" })
    await user.clear(name)
    await user.selectOptions(screen.getByRole("combobox", { name: "CPUs limit" }), "16")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onMachinesChange).not.toHaveBeenCalled()
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(name).toHaveAccessibleDescription("Use 1–32 lowercase letters, numbers, or hyphens, starting with a letter.")
    expect(screen.getByRole("combobox", { name: "CPUs limit" })).toHaveAccessibleDescription("CPUs limit cannot exceed its ceiling.")
    // Valid fields carry no stale description.
    expect(screen.getByRole("combobox", { name: "Memory limit" })).not.toHaveAttribute("aria-describedby")

    await user.type(name, "dev")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByRole("combobox", { name: "CPUs limit" })).toHaveFocus()
  })
})
