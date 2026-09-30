import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { afterEach, expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import { withResourceFixture } from "@/fixtures/application-resources"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { lifecycleGuard } from "@/features/application/model/lifecycle-guard"

afterEach(() => { toast.dismiss() })

const stoppedDev = () => withResourceFixture(applicationSourceForScenario("running", undefined, "stopped"), "start-memory")

async function palette(user: ReturnType<typeof userEvent.setup>, search: string) {
  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.type(screen.getByRole("combobox", { name: "Search commands" }), search)
}

it("asks before the palette starts a sandbox under memory pressure, inside the palette", async () => {
  const user = userEvent.setup()
  const startWorkspace = vi.fn()
  render(<ApplicationPreview source={stoppedDev()} actions={{ startWorkspace }} />)
  await palette(user, "start dev")
  await user.click(screen.getByRole("option", { name: "Start dev…" }))

  const dialog = within(screen.getByRole("dialog", { name: "Commands" }))
  expect(dialog.getByText("Starting dev may slow this computer")).toBeVisible()
  expect(dialog.getByText(/can use up to 32 GiB/)).toBeVisible()
  expect(startWorkspace).not.toHaveBeenCalled()
  await user.click(dialog.getByRole("button", { name: "Start anyway" }))
  expect(startWorkspace).toHaveBeenCalledExactlyOnceWith("dev")
  expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
})

it("returns to the command list when the palette's question is cancelled", async () => {
  const user = userEvent.setup()
  const startWorkspace = vi.fn()
  render(<ApplicationPreview source={stoppedDev()} actions={{ startWorkspace }} />)
  await palette(user, "start dev")
  await user.click(screen.getByRole("option", { name: "Start dev…" }))
  await user.click(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("button", { name: "Cancel" }))
  expect(screen.getByRole("combobox", { name: "Search commands" })).toBeVisible()
  expect(startWorkspace).not.toHaveBeenCalled()
})

it("reports unavailable VM operations from the palette instead of calling the runtime", async () => {
  const user = userEvent.setup()
  const startWorkspace = vi.fn()
  render(<ApplicationPreview source={applicationSourceForScenario("running", undefined, "stopped")} nativeOperations actions={{ startWorkspace }} />)
  await palette(user, "start dev")
  await user.click(screen.getByRole("option", { name: "Start dev" }))
  expect(await screen.findByText("Sandbox operation unavailable")).toBeVisible()
  expect(startWorkspace).not.toHaveBeenCalled()
})

it("asks next to the sandbox page's Start button, not at the bottom of the page", async () => {
  const user = userEvent.setup()
  const startWorkspace = vi.fn()
  render(<ApplicationPreview source={stoppedDev()} actions={{ startWorkspace }} />)
  await user.click(within(screen.getByRole("region", { name: "Sandboxes" })).getByRole("button", { name: "Open dev" }))
  await user.click(screen.getByRole("button", { name: "Start dev" }))
  const popover = within(document.querySelector<HTMLElement>("[data-slot=popover-content]")!)
  expect(popover.getByText("Starting dev may slow this computer")).toBeVisible()
  expect(popover.getByRole("button", { name: "Start anyway" })).toHaveFocus()
  await user.click(popover.getByRole("button", { name: "Start anyway" }))
  expect(startWorkspace).toHaveBeenCalledExactlyOnceWith("dev")
})

it("exposes one guard for other surfaces such as the status panel", () => {
  const source: ApplicationSource = stoppedDev()
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  const actions = { startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn() }
  const prompt = vi.fn()
  const guard = lifecycleGuard(source, actions, { prompt, notify: vi.fn() })
  guard.request(dev, "start")
  expect(actions.startWorkspace).not.toHaveBeenCalled()
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Start anyway" }), expect.any(Function), dev)
  prompt.mock.calls[0][1]()
  expect(actions.startWorkspace).toHaveBeenCalledExactlyOnceWith("dev")
})
