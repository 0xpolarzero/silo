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
  it("caps presets at the runtime limit on a computer with more CPUs", async () => {
    const onMachinesChange = vi.fn()
    render(<TooltipProvider><MachineList machines={[]} onMachinesChange={onMachinesChange}
      getHostCapacity={() => ({ logicalCPUs: 512, memoryGiB: 64 })} /></TooltipProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
    const ceiling = screen.getByRole("combobox", { name: "CPUs ceiling" })
    const values = [...ceiling.querySelectorAll("option")].map(option => option.value)
    expect(values).not.toContain("512")
    expect(values).toContain("255")
    await user.selectOptions(ceiling, "255")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(onMachinesChange.mock.lastCall?.[0]).toEqual([expect.objectContaining({ maxCPUs: 255 })])
  })

  it("shows the selected ceiling when switching to a computer with fewer CPUs", async () => {
    const onCommitMachine = vi.fn().mockResolvedValue(undefined)
    render(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()} onCommitMachine={onCommitMachine}
      computers={[{ id: "office", name: "Office", connected: true }]}
      getHostCapacity={computer => computer === "" ? { logicalCPUs: 4, memoryGiB: 16 } : undefined} /></TooltipProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
    await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "office")
    await user.selectOptions(screen.getByRole("combobox", { name: "CPUs ceiling" }), "12")
    await user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), "")
    const ceiling = screen.getByRole("spinbutton", { name: "CPUs ceiling custom (CPUs)" })
    expect(ceiling).toHaveDisplayValue("12")
    await user.clear(ceiling)
    await user.type(ceiling, "4")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(onCommitMachine).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxCPUs: 4 }), undefined, "", [])
  })

  it("caps custom CPU counts at what the runtime accepts", async () => {
    const { user } = await openNewSandbox()
    const input = await enterCustom(user, "CPUs ceiling", "CPUs", "12")
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
    const input = await enterCustom(user, "CPUs ceiling", "CPUs", value)
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(onMachinesChange).not.toHaveBeenCalled()
    expect(input).toHaveAccessibleDescription("Enter a whole number of CPUs from 1 to 255.")
    // What the user typed stays visible so they can correct it. (jsdom drops the partial
    // "1e" while typing, which browsers keep as raw text, so skip the exponent case.)
    if (value !== "1e3") expect(input).toHaveDisplayValue(value)
    expect(screen.queryByText(/expected|Too (small|big)/)).not.toBeInTheDocument()
  })

  it("explains memory and storage ranges in the same words", async () => {
    const { user, onMachinesChange } = await openNewSandbox()
    const memory = await enterCustom(user, "Memory", "GiB", "0")
    const storage = await enterCustom(user, "Workspace disk", "GiB", "2.5")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(onMachinesChange).not.toHaveBeenCalled()
    expect(memory).toHaveAccessibleDescription(/^Enter a whole number of GiB from 1 to [\d,]+\.$/)
    expect(storage).toHaveAccessibleDescription("Enter a whole number of GiB from 1 to 4,194,303.")
  })

  it("fits a new sandbox to a small computer so Create succeeds", async () => {
    const onMachinesChange = vi.fn()
    render(<TooltipProvider><MachineList machines={[]} onMachinesChange={onMachinesChange} getHostCapacity={(computer) => computer === "" ? { logicalCPUs: 8, memoryGiB: 16 } : undefined} /></TooltipProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
    expect(screen.getByRole("combobox", { name: "CPUs ceiling" })).toHaveValue("8")
    expect(screen.getByRole("combobox", { name: "Memory ceiling" })).toHaveValue("16")
    const options = (label: string) => [...screen.getByRole("combobox", { name: label }).querySelectorAll("option")].map(option => option.value)
    expect(options("CPUs ceiling")).toEqual(["1", "2", "4", "6", "8", "custom"])
    expect(options("Memory ceiling")).toEqual(["1", "2", "4", "8", "12", "16", "custom"])
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(onMachinesChange.mock.lastCall?.[0]).toEqual([expect.objectContaining({ cpus: 4, maxCPUs: 8, memoryGiB: 8, maxMemoryGiB: 16 })])
  })

  it("rejects a ceiling above the computer before the runtime does", async () => {
    const onMachinesChange = vi.fn()
    render(<TooltipProvider><MachineList machines={[]} onMachinesChange={onMachinesChange} getHostCapacity={() => ({ logicalCPUs: 8, memoryGiB: 16 })} /></TooltipProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
    const input = await enterCustom(user, "CPUs ceiling", "CPUs", "12")
    expect(input).toHaveAttribute("max", "8")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(onMachinesChange).not.toHaveBeenCalled()
    expect(input).toHaveAccessibleDescription("This computer has 8 CPUs. Choose 8 or fewer.")
  })

  it("saves a valid whole custom value", async () => {
    const { user, onMachinesChange } = await openNewSandbox()
    await enterCustom(user, "CPUs ceiling", "CPUs", "10")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(onMachinesChange.mock.lastCall?.[0]).toEqual([expect.objectContaining({ maxCPUs: 10 })])
  })
})
