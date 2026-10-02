import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { LogFilters } from "./log-filters"

it.each(["Escape", "Cancel", "Last hour"])("returns focus to the date editor button after %s", async (dismissal) => {
  const user = userEvent.setup()
  render(<LogFilters source="" since="2026-10-01T00:00:00.000Z" until="" onChange={vi.fn()} />)
  const edit = screen.getByRole("button", { name: "Edit date filter" })
  await user.click(edit)
  expect(screen.getByRole("dialog", { name: "Filter by date" })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole("button", { name: "Last hour" })).toHaveFocus())
  if (dismissal === "Escape") await user.keyboard("{Escape}")
  else await user.click(screen.getByRole("button", { name: dismissal }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter by date" })).not.toBeInTheDocument())
  expect(edit).toHaveFocus()
})

it("returns focus to the filter input after cancelling a new date filter without reopening suggestions", async () => {
  const user = userEvent.setup()
  render(<LogFilters source="" since="" until="" onChange={vi.fn()} />)
  const input = screen.getByRole("combobox", { name: "Filter logs" })
  await user.type(input, "Date")
  await user.keyboard("{Enter}")
  await waitFor(() => expect(screen.getByRole("button", { name: "Last hour" })).toHaveFocus())
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(input).toHaveFocus())
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  await user.click(input)
  expect(screen.getByRole("listbox")).toBeInTheDocument()
})

it("preserves focus on an outside control when it dismisses the date editor", async () => {
  const user = userEvent.setup()
  render(<><LogFilters source="" since="2026-10-01T00:00:00.000Z" until="" onChange={vi.fn()} /><button>Next control</button></>)
  await user.click(screen.getByRole("button", { name: "Edit date filter" }))
  await user.click(screen.getByRole("button", { name: "Next control" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus()
})
