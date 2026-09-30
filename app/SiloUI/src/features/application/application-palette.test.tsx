import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { afterEach, expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationSource } from "@/features/application/model/application-source"

afterEach(() => { toast.dismiss() })

async function run(user: ReturnType<typeof userEvent.setup>, search: string, option: string | RegExp) {
  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.type(screen.getByRole("combobox", { name: "Search commands" }), search)
  await user.click(screen.getByRole("option", { name: option }))
}

function withStoppedDev(): ApplicationSource {
  const source = structuredClone(applicationSourceForScenario("running"))
  source.workspaces.find(({ machine }) => machine.name === "dev")!.state = "stopped"
  return source
}

it("opens a sandbox's page and its Checkpoints tab", async () => {
  const user = userEvent.setup()
  render(<ApplicationPreview source={applicationSourceForScenario("running")} />)
  await run(user, "open dev", "Open dev")
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesdev")
  await run(user, "dev checkpoints", "Open dev checkpoints")
  expect(screen.getByRole("tab", { name: "Checkpoints" })).toHaveAttribute("aria-selected", "true")
})

it("opens the same folder picker as the editor buttons instead of opening the editor directly", async () => {
  const user = userEvent.setup()
  const openEditor = vi.fn()
  const source = applicationSourceForScenario("running")
  render(<ApplicationPreview source={source} actions={{ openEditor }} />)
  await run(user, "dev editor", `Open dev in ${source.preferences.editor}…`)
  expect(await screen.findByRole("heading", { name: "dev folders" })).toBeVisible()
  expect(openEditor).not.toHaveBeenCalled()
})

it("forks from the palette through the sandbox's own Fork popover", async () => {
  const user = userEvent.setup()
  render(<ApplicationPreview source={applicationSourceForScenario("running")} />)
  await run(user, "fork dev", "Fork dev…")
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesdev")
  const popover = await waitFor(() => within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!))
  expect(popover.getByText("Fork dev")).toBeVisible()
  expect(popover.getByRole("textbox")).toHaveFocus()

  // Leaving the page and coming back does not reopen the popover.
  await user.keyboard("{Escape}")
  await waitFor(() => expect(document.querySelector("[data-slot=popover-content]")).toBeNull())
  await user.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Sandboxes" }))
  await user.click(within(screen.getByRole("region", { name: "Sandboxes" })).getByRole("button", { name: "Open dev" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesdev")
  expect(document.querySelector("[data-slot=popover-content]")).toBeNull()
})

it("deletes from the palette through the one Delete dialog", async () => {
  const user = userEvent.setup()
  const saveMachineConfiguration = vi.fn()
  render(<ApplicationPreview source={withStoppedDev()} actions={{ saveMachineConfiguration }} />)
  await run(user, "delete dev", "Delete dev…")
  const popover = await waitFor(() => within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!))
  expect(popover.getByText("Delete dev permanently?")).toBeVisible()
  await user.click(popover.getByRole("button", { name: "Delete permanently" }))
  await waitFor(() => expect(saveMachineConfiguration).toHaveBeenCalled())
})

it("does not offer Delete for a running sandbox", async () => {
  const user = userEvent.setup()
  render(<ApplicationPreview source={applicationSourceForScenario("running")} />)
  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.type(screen.getByRole("combobox", { name: "Search commands" }), "delete dev")
  expect(screen.queryByRole("option", { name: "Delete dev…" })).not.toBeInTheDocument()
})

it("starts a new sandbox from the palette", async () => {
  const user = userEvent.setup()
  render(<ApplicationPreview source={applicationSourceForScenario("running")} />)
  await run(user, "new sandbox", "New sandbox…")
  expect(await screen.findByRole("textbox", { name: "Sandbox name" })).toBeVisible()
})

it("keeps same-named sandboxes on different computers apart", async () => {
  const user = userEvent.setup()
  const openTerminal = vi.fn()
  const source = structuredClone(applicationSourceForScenario("running"))
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  const twin = (id: string) => ({ ...structuredClone(dev), machine: { ...dev.machine, id: `remote-${id}` }, computer: { id, vmId: `vm-${id}`, name: "Office", address: `${id}.test`, connected: true } })
  source.workspaces = [twin("first"), twin("second")]
  source.remoteComputers = [{ id: "first", name: "Office", address: "first.test", connected: true }, { id: "second", name: "Office", address: "second.test", connected: true }]
  render(<ApplicationPreview source={source} actions={{ openTerminal }} />)
  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.type(screen.getByRole("combobox", { name: "Search commands" }), "dev terminal")
  const options = screen.getAllByRole("option", { name: `Open dev on Office in ${source.preferences.terminal}` })
  expect(options).toHaveLength(2)
  // Keyboard selection tells the two apart only when each item has its own value.
  expect(options.filter(option => option.getAttribute("aria-selected") === "true")).toHaveLength(1)
  await user.keyboard("{ArrowDown}{Enter}")
  expect(openTerminal).toHaveBeenCalledExactlyOnceWith("silo-remote:second:vm-second")
})
