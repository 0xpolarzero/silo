import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MachineList } from "./machine-list"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"

it("opens the Add menu with the keyboard and navigates its items", async () => {
  const onImportSandbox = vi.fn()
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()} onImportSandbox={onImportSandbox} /></TooltipProvider>)
  const add = screen.getByRole("button", { name: "Add" })
  add.focus()
  await user.keyboard("{ArrowDown}")
  expect(screen.getByRole("menu", { name: "Add sandbox" })).toBeVisible()
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "New sandbox" })).toHaveFocus())
  await user.keyboard("{ArrowDown}")
  expect(screen.getByRole("menuitem", { name: "Connect an SSH host…" })).toHaveFocus()
  await user.keyboard("{End}")
  expect(screen.getByRole("menuitem", { name: "Import sandbox…" })).toHaveFocus()
  await user.keyboard("{Home}{Escape}")
  await waitFor(() => expect(add).toHaveFocus())
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(onImportSandbox).not.toHaveBeenCalled()
})

it("hands focus to the new sandbox editor after a keyboard menu selection", async () => {
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()} /></TooltipProvider>)
  screen.getByRole("button", { name: "Add" }).focus()
  await user.keyboard("{Enter}")
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "New sandbox" })).toHaveFocus())
  await user.keyboard("{Enter}")
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Sandbox name" })).toHaveFocus())
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
})

it("restores Add focus when an import selection opens no review", async () => {
  const onImportSandbox = vi.fn()
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()} onImportSandbox={onImportSandbox} /></TooltipProvider>)
  const add = screen.getByRole("button", { name: "Add" })
  await user.click(add)
  await user.click(screen.getByRole("menuitem", { name: "Import sandbox…" }))
  expect(onImportSandbox).toHaveBeenCalledOnce()
  await waitFor(() => expect(add).toHaveFocus())
})

it("returns focus to Add when a new sandbox editor is cancelled", async () => {
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()} /></TooltipProvider>)
  const add = screen.getByRole("button", { name: "Add" })
  await user.click(add)
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByRole("textbox", { name: "Sandbox name" })).not.toBeInTheDocument()
  expect(add).toHaveFocus()
})

it("returns focus to the row's edit control when its editor is cancelled", async () => {
  const machine = productionMachineDefaults[0]
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `Edit ${machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.getByRole("button", { name: `Edit ${machine.name}` })).toHaveFocus()
})

it("returns focus to the row menu when edits opened from that menu are discarded", async () => {
  const machine = productionMachineDefaults[0]
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.getByRole("button", { name: `More actions for ${machine.name}` })).toHaveFocus()
})

it("returns focus to the source row when a duplicate editor is cancelled", async () => {
  const machine = productionMachineDefaults[0]
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `Duplicate settings for ${machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.getByRole("button", { name: `Edit ${machine.name}` })).toHaveFocus()
})

it("returns focus to the row after a successful asynchronous save", async () => {
  const machine = productionMachineDefaults[0]
  const user = userEvent.setup()
  const onCommitMachine = vi.fn().mockResolvedValue(undefined)
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} onCommitMachine={onCommitMachine} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `Edit ${machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(screen.getByRole("button", { name: `Edit ${machine.name}` })).toHaveFocus())
  expect(onCommitMachine).toHaveBeenCalledOnce()
})

it("preserves focus moved outside the editor while a save settles", async () => {
  const machine = productionMachineDefaults[0]
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]}
    onMachinesChange={() => screen.getByRole("button", { name: "Other action" }).focus()}
    footer={<button type="button">Other action</button>} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `Edit ${machine.name}` }))
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByRole("button", { name: "Other action" })).toHaveFocus()
})

it.each(["Edit", "Duplicate settings for"])("focuses the editor after selecting %s from the row menu", async action => {
  const machine = productionMachineDefaults[0]
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[machine]} onMachinesChange={vi.fn()} getRowPresentation={() => ({ menuActions: [] })} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `${action} ${machine.name}` }))
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Sandbox name" })).toHaveFocus())
})

it("describes the reorder keys and announces a keyboard move without losing focus", async () => {
  const first = productionMachineDefaults[0]
  const second = { ...first, id: "00000000-0000-4000-8000-0000000000ff", name: "second" }
  const onMachinesChange = vi.fn()
  const view = (machines: typeof first[]) => <TooltipProvider><MachineList machines={machines} onMachinesChange={onMachinesChange} /></TooltipProvider>
  const { rerender } = render(view([first, second]))
  const user = userEvent.setup()
  const reorder = screen.getByRole("button", { name: `Reorder ${first.name}` })
  expect(reorder).toHaveAccessibleDescription("Use the Up and Down arrow keys to reorder.")
  reorder.focus()
  await user.keyboard("{ArrowDown}")
  expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith([second, first], [first, second])
  rerender(view([second, first]))
  expect(reorder).toHaveFocus()
  expect(screen.getByText(`${first.name} moved to position 2 of 2.`)).toHaveAttribute("aria-live", "polite")
})
