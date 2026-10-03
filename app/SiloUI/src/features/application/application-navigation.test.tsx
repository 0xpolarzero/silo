import { act, render, screen, within } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { setupFakeTimerUser } from "@/test/fake-timer-user"
import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-10-02T12:00:00Z") }) })

function computersPanel() {
  return within(screen.getByRole("region", { name: "Computers" }))
}

it("replaces a deleted computer's page in history instead of pushing the list after it", async () => {
  const user = setupFakeTimerUser()
  const source = applicationSourceForScenario("running")
  const view = render(<ApplicationPreview source={source} />)
  await user.click(computersPanel().getByRole("button", { name: "Open playgrounds" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Computersplaygrounds")

  view.rerender(<ApplicationPreview source={{ ...source, computers: source.computers.filter(({ configuration }) => configuration.name !== "playgrounds") }} />)

  expect(computersPanel().getByRole("list", { name: "Configured computers" })).toBeVisible()
  // Back would otherwise land on the deleted computer's entry and bounce forward again.
  expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled()
})

afterEach(() => { toast.dismiss() })

it("keeps operation progress and Cancel on screen while moving between sections", async () => {
  const user = setupFakeTimerUser()
  const cancelOperation = vi.fn()
  const source = structuredClone(applicationSourceForScenario("running"))
  source.operationQueue = {
    running: [{ id: 4, label: "Saving Git identities", kind: "other", computerId: null, computerName: null, sinceMs: Date.now() - 60_000, cancellable: true, expectedMs: null, blockedByHidden: false }],
    waiting: [],
  }
  render(<ApplicationPreview source={source} actions={{ cancelOperation }} />)
  const toasts = () => within(screen.getByRole("region", { name: /Notifications/ }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(toasts().getByText("Saving Git identities")).toBeInTheDocument()

  const sections = within(within(screen.getByRole("navigation", { name: "Silo navigation" })).getByRole("group", { name: "Computer sections" }))
  await user.click(sections.getByRole("button", { name: "Files" }))
  await user.click(sections.getByRole("button", { name: "Logs" }))
  // A dismissed toast lingers only for its exit animation.
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(toasts().getByText("Saving Git identities")).toBeInTheDocument()
  await user.click(toasts().getByRole("button", { name: "Cancel" }))
  expect(cancelOperation).toHaveBeenCalledWith(4)
})
