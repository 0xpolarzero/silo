import { act, render, screen, within } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { setupFakeTimerUser } from "@/test/fake-timer-user"
import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-10-02T12:00:00Z") }) })

function sandboxesPanel() {
  return within(screen.getByRole("region", { name: "Sandboxes" }))
}

it("replaces a deleted sandbox's page in history instead of pushing the list after it", async () => {
  const user = setupFakeTimerUser()
  const source = applicationSourceForScenario("running")
  const view = render(<ApplicationPreview source={source} />)
  await user.click(sandboxesPanel().getByRole("button", { name: "Open playgrounds" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesplaygrounds")

  view.rerender(<ApplicationPreview source={{ ...source, workspaces: source.workspaces.filter(({ machine }) => machine.name !== "playgrounds") }} />)

  expect(sandboxesPanel().getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
  // Back would otherwise land on the deleted sandbox's entry and bounce forward again.
  expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled()
})

afterEach(() => { toast.dismiss() })

it("keeps operation progress and Cancel on screen while moving between sections", async () => {
  const user = setupFakeTimerUser()
  const cancelOperation = vi.fn()
  const source = structuredClone(applicationSourceForScenario("running"))
  source.operationQueue = {
    running: [{ id: 4, label: "Saving Git identities", kind: "other", vmId: null, vmName: null, sinceMs: Date.now() - 60_000, cancellable: true, expectedMs: null, blockedByHidden: false }],
    waiting: [],
  }
  render(<ApplicationPreview source={source} actions={{ cancelOperation }} />)
  const toasts = () => within(screen.getByRole("region", { name: /Notifications/ }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(toasts().getByText("Saving Git identities")).toBeInTheDocument()

  const sections = within(within(screen.getByRole("navigation", { name: "Silo navigation" })).getByRole("group", { name: "Sandbox sections" }))
  await user.click(sections.getByRole("button", { name: "Files" }))
  await user.click(sections.getByRole("button", { name: "Logs" }))
  // A dismissed toast lingers only for its exit animation.
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(toasts().getByText("Saving Git identities")).toBeInTheDocument()
  await user.click(toasts().getByRole("button", { name: "Cancel" }))
  expect(cancelOperation).toHaveBeenCalledWith(4)
})
