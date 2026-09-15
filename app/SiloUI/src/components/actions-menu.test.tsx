import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { ActionsMenu } from "./actions-menu"
import { TooltipProvider } from "./ui/tooltip"

it("supports keyboard selection and returns focus when dismissed", async () => {
  const select = vi.fn()
  const user = userEvent.setup()
  render(<TooltipProvider><ActionsMenu label="More actions" items={[{ label: "Edit", onSelect: select }, { label: "Restart", disabled: true, onSelect: vi.fn() }]} /></TooltipProvider>)
  await user.tab()
  await user.keyboard("{ArrowDown}")
  expect(await screen.findByRole("menuitem", { name: "Edit" })).toHaveFocus()
  await user.keyboard("{Enter}")
  expect(select).toHaveBeenCalledOnce()
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "More actions" })).toHaveFocus()
})
