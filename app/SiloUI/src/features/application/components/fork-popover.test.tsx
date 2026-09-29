import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { ForkPopover } from "./fork-popover"

it("closes at once on submit and hands the trimmed name to the caller", async () => {
  const onFork = vi.fn()
  const onOpenChange = vi.fn()
  render(<ForkPopover open onOpenChange={onOpenChange} anchor={<button type="button" aria-label="More actions for dev">⋯</button>} sandboxName="dev" onFork={onFork} />)

  expect(screen.getByText("Fork dev")).toBeVisible()
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()
  fireEvent.change(screen.getByRole("textbox", { name: "New sandbox name" }), { target: { value: " experiment " } })
  fireEvent.click(screen.getByRole("button", { name: "Fork" }))

  expect(onOpenChange).toHaveBeenCalledWith(false)
  await vi.waitFor(() => expect(onFork).toHaveBeenCalledWith("experiment"))
})

it("does not submit while disabled", () => {
  const onFork = vi.fn()
  render(<ForkPopover open onOpenChange={vi.fn()} anchor={<button type="button">⋯</button>} sandboxName="dev" disabled onFork={onFork} />)
  fireEvent.change(screen.getByRole("textbox", { name: "New sandbox name" }), { target: { value: "experiment" } })
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()
})
