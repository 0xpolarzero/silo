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

async function enterCustom(user: ReturnType<typeof userEvent.setup>, label: string, unit: string, value: string) {
  await user.selectOptions(screen.getByRole("combobox", { name: label }), "custom")
  const input = screen.getByRole("spinbutton", { name: `${label} custom (${unit})` })
  await user.clear(input)
  if (value) await user.type(input, value)
  return input
}

describe("machine editor resource fields", () => {
  it("caps custom CPU counts at what the runtime accepts", async () => {
    const { user } = await openNewSandbox()
    const input = await enterCustom(user, "CPU ceiling", "CPUs", "12")
    expect(input).toHaveAttribute("max", "255")
    expect(input).toHaveAttribute("step", "1")
  })

  it.each([
    ["an empty value", ""],
    ["a fraction", "1.5"],
    ["an exponent", "1e3"],
    ["more than the runtime accepts", "300"],
  ])("rejects %s with a readable message instead of saving", async (_case, value) => {
    const { user, onMachinesChange } = await openNewSandbox()
    const input = await enterCustom(user, "CPU ceiling", "CPUs", value)
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange).not.toHaveBeenCalled()
    expect(input).toHaveAccessibleDescription("Enter a whole number of CPUs from 1 to 255.")
    // What the user typed stays visible so they can correct it. (jsdom drops the partial
    // "1e" while typing, which browsers keep as raw text, so skip the exponent case.)
    if (value !== "1e3") expect(input).toHaveDisplayValue(value)
    expect(screen.queryByText(/expected|Too (small|big)/)).not.toBeInTheDocument()
  })

  it("explains memory and storage ranges in the same words", async () => {
    const { user, onMachinesChange } = await openNewSandbox()
    const memory = await enterCustom(user, "Memory limit", "GiB", "0")
    const storage = await enterCustom(user, "Workspace storage", "GiB", "2.5")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange).not.toHaveBeenCalled()
    expect(memory).toHaveAccessibleDescription(/^Enter a whole number of GB from 1 to [\d,]+\.$/)
    expect(storage).toHaveAccessibleDescription("Enter a whole number of GB from 1 to 4,194,303.")
  })

  it("saves a valid whole custom value", async () => {
    const { user, onMachinesChange } = await openNewSandbox()
    await enterCustom(user, "CPU ceiling", "CPUs", "10")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange.mock.lastCall?.[0]).toEqual([expect.objectContaining({ maxCPUs: 10 })])
  })
})
