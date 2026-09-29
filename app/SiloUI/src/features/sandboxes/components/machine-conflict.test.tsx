import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import type { SetupVirtualMachineConfiguration } from "@/contracts/silo"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0]
const staleError = new Error("This VM changed while your edit was waiting. Review it and try again.")

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
  await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "4")
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("This VM changed since you opened it.")
  // The edited value is preserved rather than discarded.
  expect(screen.getByRole("combobox", { name: "CPU limit" })).toHaveValue("4")
  expect(screen.getByRole("button", { name: "Review changes" })).toBeInTheDocument()

  // Review changes reloads the latest configuration and clears the conflict.
  await user.click(screen.getByRole("button", { name: "Review changes" }))
  expect(screen.queryByText("This VM changed since you opened it.")).not.toBeInTheDocument()
  expect(screen.getByRole("combobox", { name: "CPU limit" })).toHaveValue(String(machine.cpus))
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
  expect(await screen.findByRole("status")).toHaveTextContent("This VM was changed elsewhere.")
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
})

it("reports a stale rejection of Add Linux desktop, which has no editor to show it", async () => {
  const onCommitMachine = vi.fn().mockRejectedValue(staleError)
  render(<TooltipProvider><Toaster /><MachineList machines={[machine]} onMachinesChange={vi.fn()} onCommitMachine={onCommitMachine}
    getComputerId={() => "office"} isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: "Add Linux desktop" }))
  expect(await screen.findByText(`Couldn't save ${machine.name}`)).toBeVisible()
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
  await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "4")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  await act(async () => reject(staleError))
  expect(await screen.findByText(`Couldn't save ${machine.name}`)).toBeVisible()
  expect(screen.getByText(staleError.message)).toBeVisible()
})

it("blocks saving when the VM was deleted elsewhere while the editor is open", async () => {
  const { view } = await openEditor([machine])
  view.rerender(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()}
    isMachineCreated={() => true} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  expect(await screen.findByText("This VM no longer exists.")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
})
