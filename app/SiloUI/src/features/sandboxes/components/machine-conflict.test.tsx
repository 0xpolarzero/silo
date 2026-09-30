import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import type { SetupVirtualMachineConfiguration } from "@/contracts/silo"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0]
const staleError = new Error("This sandbox changed while your edit was waiting. Review it and try again.")

async function openEditor(machines: readonly SetupVirtualMachineConfiguration[], props: Record<string, unknown> = {}) {
  const view = render(<TooltipProvider><MachineList machines={machines} onMachinesChange={vi.fn()}
    isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} {...props} /></TooltipProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${machine.name}` }))
  return { user, view }
}

it("keeps the editor open with the user's edits when a save is rejected as stale", async () => {
  const onCommitMachine = vi.fn().mockRejectedValue(staleError)
  const { user } = await openEditor([machine], { onCommitMachine, getComputerId: () => "" })
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("This sandbox changed since you opened it.")
  // The edited value is preserved rather than discarded.
  expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
  expect(screen.getByRole("button", { name: "Review changes" })).toBeInTheDocument()

  // Review changes clears the conflict but keeps the user's edit on the latest settings.
  await user.click(screen.getByRole("button", { name: "Review changes" }))
  expect(screen.queryByText("This sandbox changed since you opened it.")).not.toBeInTheDocument()
  expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
  expect(screen.getByRole("status", { name: "Review changes" })).toHaveTextContent("Your edits are kept on top of the latest settings.")
})

it("shows fields changed on both sides and saves the user's edits on top of the latest settings", async () => {
  const onCommitMachine = vi.fn().mockRejectedValueOnce(staleError).mockResolvedValue(undefined)
  const props = { onCommitMachine, getComputerId: () => "" }
  const { user, view } = await openEditor([machine], props)
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  const latest = { ...machine, cpus: 6, maxMemoryGiB: 64 }
  view.rerender(<TooltipProvider><MachineList machines={[latest]} onMachinesChange={vi.fn()}
    isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} {...props} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: "Save" }))
  await user.click(await screen.findByRole("button", { name: "Review changes" }))

  const review = screen.getByRole("status", { name: "Review changes" })
  expect(review).toHaveTextContent("CPUs: yours 4 CPUs, elsewhere 6 CPUs")
  expect(review).toHaveTextContent("Updated from elsewhere: Memory ceiling.")
  expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
  expect(screen.getByRole("combobox", { name: "Memory ceiling" })).toHaveValue("64")

  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(onCommitMachine).toHaveBeenLastCalledWith({ ...latest, cpus: 4 }, latest, "", [latest])
})

it("discards edits and closes the editor from the conflict prompt", async () => {
  const onCommitMachine = vi.fn().mockRejectedValue(staleError)
  const { user } = await openEditor([machine], { onCommitMachine, getComputerId: () => "" })
  await user.click(screen.getByRole("button", { name: "Save" }))
  await screen.findByRole("button", { name: "Discard my edits" })
  await user.click(screen.getByRole("button", { name: "Discard my edits" }))
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
})

it("notices when the VM is changed elsewhere while the editor is open", async () => {
  const { view } = await openEditor([machine])
  view.rerender(<TooltipProvider><MachineList machines={[{ ...machine, maxCPUs: 4 }]} onMachinesChange={vi.fn()}
    isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  expect(await screen.findByRole("status")).toHaveTextContent("This sandbox was changed elsewhere.")
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
})

it("reports a stale rejection of Add Linux desktop, which has no editor to show it", async () => {
  const onCommitMachine = vi.fn().mockRejectedValue(staleError)
  render(<TooltipProvider><Toaster /><MachineList machines={[machine]} onMachinesChange={vi.fn()} onCommitMachine={onCommitMachine}
    getComputerId={() => "office"} isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: "Add Linux desktop" }))
  expect(await screen.findByText(`Could not save ${machine.name}`)).toBeVisible()
  expect(screen.getByText(staleError.message)).toBeVisible()
})

it("reports a stale rejection after the editor closed on a local save", async () => {
  let reject!: (cause: unknown) => void
  const onMachinesChange = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  render(<TooltipProvider><Toaster /><MachineList machines={[machine]} onMachinesChange={onMachinesChange}
    isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${machine.name}` }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  await act(async () => reject(staleError))
  expect(await screen.findByText(`Could not save ${machine.name}`)).toBeVisible()
  expect(screen.getByText(staleError.message)).toBeVisible()
})

it("blocks saving when the VM was deleted elsewhere while the editor is open", async () => {
  const { view } = await openEditor([machine])
  view.rerender(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()}
    isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  expect(await screen.findByText("This sandbox no longer exists.")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
})
