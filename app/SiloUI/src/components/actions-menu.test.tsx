import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { ActionsMenu } from "./actions-menu"
import { ConfirmBody, FormBody } from "./confirm-popover"
import { TooltipProvider } from "./ui/tooltip"

it("retains a menu form when Escape cancels an IME candidate", async () => {
  const user = userEvent.setup()
  render(<TooltipProvider><ActionsMenu label="More actions" items={[{ label: "Fork", popover: "fork" }]}
    popovers={{ fork: close => <FormBody title="Fork dev" confirmLabel="Fork" fields={<input aria-label="New name" defaultValue="draft" />} onSubmit={vi.fn()} onClose={close} /> }} />
  </TooltipProvider>)
  const trigger = screen.getByRole("button", { name: "More actions" })
  await user.click(trigger)
  await user.click(screen.getByRole("menuitem", { name: "Fork" }))
  const input = screen.getByRole("textbox", { name: "New name" })
  await waitFor(() => expect(input).toHaveFocus())
  fireEvent.keyDown(input, { key: "Escape", isComposing: true })
  expect(screen.getByRole("dialog", { name: "Fork" })).toBeVisible()
  expect(input).toHaveValue("draft")
  expect(input).toHaveFocus()
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  await waitFor(() => expect(trigger).toHaveFocus())
})

it.each(["menu", "palette"] as const)("names a confirmation opened through the %s", async source => {
  const user = userEvent.setup()
  render(<TooltipProvider><ActionsMenu label="More actions for dev"
    items={[{ label: "Delete", accessibleLabel: "Delete dev", popover: "delete" }]}
    popovers={{ delete: close => <ConfirmBody title="Delete dev?" confirmLabel="Delete permanently" onConfirm={vi.fn()} onClose={close} /> }}
    openPanel={source === "palette" ? { token: 1, panel: "delete" } : undefined}
  /></TooltipProvider>)
  if (source === "menu") {
    await user.click(screen.getByRole("button", { name: "More actions for dev" }))
    await user.click(screen.getByRole("menuitem", { name: "Delete dev" }))
  }
  expect(screen.getByRole("dialog", { name: "Delete dev" })).toContainElement(screen.getByText("Delete dev?"))
})

it("preserves focus on an outside control when a menu confirmation is dismissed", async () => {
  const user = userEvent.setup()
  render(<TooltipProvider>
    <ActionsMenu label="More actions for dev" items={[{ label: "Delete", popover: "delete" }]}
      popovers={{ delete: close => <ConfirmBody title="Delete dev?" confirmLabel="Delete permanently" onConfirm={vi.fn()} onClose={close} /> }} />
    <button type="button">Another action</button>
  </TooltipProvider>)
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete" }))
  const outside = screen.getByRole("button", { name: "Another action" })
  await user.click(outside)
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(outside).toHaveFocus()
})

it("supports keyboard selection and returns focus when dismissed", async () => {
  const select = vi.fn()
  const user = userEvent.setup()
  render(<TooltipProvider><ActionsMenu label="More actions" items={[{ label: "Edit", onSelect: select }, { label: "Restart", disabled: true, onSelect: vi.fn() }]} /></TooltipProvider>)
  await user.tab()
  await user.keyboard("{ArrowDown}")
  const edit = await screen.findByRole("menuitem", { name: "Edit" })
  expect(edit).toHaveFocus()
  await user.keyboard("{Enter}")
  expect(select).toHaveBeenCalledOnce()
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "More actions" })).toHaveFocus()
})
