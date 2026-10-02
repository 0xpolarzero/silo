import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Square } from "lucide-react"
import { expect, it, vi } from "vitest"

import { ApplicationCommandMenu } from "./application-command-menu"

it.each(["Escape", "Cancel"])("focuses the search input after cancelling a command confirmation with %s", async (dismissal) => {
  const user = userEvent.setup()
  const run = vi.fn()
  render(<ApplicationCommandMenu commands={[{
    id: "stop", label: "Stop dev", group: "Actions", icon: Square, run,
    confirm: { title: "Stop dev?", description: "Processes will stop.", confirmLabel: "Stop", tone: "destructive" },
  }]} />)
  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.keyboard("{Enter}")
  expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus()
  if (dismissal === "Escape") await user.keyboard("{Escape}")
  else await user.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Search commands" })).toHaveFocus())
  expect(run).not.toHaveBeenCalled()
  await user.keyboard("stop")
  expect(screen.getByRole("combobox", { name: "Search commands" })).toHaveValue("stop")
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(screen.getByRole("button", { name: "Search or jump to" })).toHaveFocus()
})
