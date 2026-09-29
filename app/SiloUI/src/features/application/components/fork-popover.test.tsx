import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { ActionsMenu } from "@/components/actions-menu"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ForkBody } from "./fork-popover"

function setup(onFork = vi.fn(), disabled = false) {
  render(<TooltipProvider><ActionsMenu label="More actions for dev" items={[{ label: "Fork…", accessibleLabel: "Fork dev", popover: "fork" }]} popovers={{ fork: close => <ForkBody sandboxName="dev" disabled={disabled} onFork={onFork} onClose={close} /> }} /></TooltipProvider>)
  return onFork
}

async function openFork(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(await screen.findByRole("menuitem", { name: "Fork dev" }))
}

it("closes at once on submit and hands the trimmed name to the caller", async () => {
  const user = userEvent.setup()
  const onFork = setup()
  await openFork(user)
  expect(await screen.findByText("Fork dev")).toBeVisible()
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()
  await user.type(screen.getByRole("textbox", { name: "New sandbox name" }), " experiment ")
  await user.click(screen.getByRole("button", { name: "Fork" }))
  expect(screen.queryByText("Fork dev")).not.toBeInTheDocument()
  await waitFor(() => expect(onFork).toHaveBeenCalledWith("experiment"))
})

it("does not submit while disabled", async () => {
  const user = userEvent.setup()
  setup(vi.fn(), true)
  await openFork(user)
  await user.type(await screen.findByRole("textbox", { name: "New sandbox name" }), "experiment")
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()
})

it("turns off auto-capitalization and autocorrect on the name field", async () => {
  const user = userEvent.setup()
  setup()
  await openFork(user)
  const input = await screen.findByRole("textbox", { name: "New sandbox name" })
  expect(input).toHaveAttribute("autocapitalize", "off")
  expect(input).toHaveAttribute("autocorrect", "off")
  expect(input).toHaveAttribute("spellcheck", "false")
  expect(input).toHaveAttribute("autocomplete", "off")
})

it("rejects invalid or taken names inline before submit", async () => {
  const user = userEvent.setup()
  const onFork = vi.fn()
  render(<TooltipProvider><ActionsMenu label="More actions for dev" items={[{ label: "Fork…", accessibleLabel: "Fork dev", popover: "fork" }]} popovers={{ fork: close => <ForkBody sandboxName="dev" takenNames={["dev", "taken"]} onFork={onFork} onClose={close} /> }} /></TooltipProvider>)
  await openFork(user)
  const input = await screen.findByRole("textbox", { name: "New sandbox name" })
  await user.type(input, "My Fork")
  expect(screen.getByText(/lowercase letters, numbers, or hyphens/)).toBeVisible()
  expect(input).toHaveAttribute("aria-invalid", "true")
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()
  await user.clear(input)
  await user.type(input, "taken")
  expect(screen.getByText("A sandbox named taken already exists.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled()
  await user.clear(input)
  await user.type(input, "fresh")
  await user.click(screen.getByRole("button", { name: "Fork" }))
  await waitFor(() => expect(onFork).toHaveBeenCalledWith("fresh"))
})

it("Escape closes the popover and it stays closed", async () => {
  const user = userEvent.setup()
  setup()
  await openFork(user)
  await screen.findByText("Fork dev")
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByText("Fork dev")).not.toBeInTheDocument())
})
