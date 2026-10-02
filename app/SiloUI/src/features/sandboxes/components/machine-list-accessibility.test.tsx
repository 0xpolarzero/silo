import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MachineList } from "./machine-list"

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
