import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { ActionsMenu } from "./actions-menu"
import { ConfirmBody } from "./confirm-popover"
import { TooltipProvider } from "./ui/tooltip"

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
