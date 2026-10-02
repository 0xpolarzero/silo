import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import * as operationToast from "@/lib/operation-toast"
import { createApplicationActionsMock } from "@/test/application-actions"
import { GitHubPage } from "./github-page"

it.each([false, true])("discards rejected access and its retry when dev is replaced (removed first=%s)", async (removedFirst) => {
  const user = userEvent.setup()
  const failure = vi.spyOn(operationToast, "showOperationFailure")
  const source = applicationSourceForScenario("running", "connected")
  source.github.policyRevision = 10
  const actions = createApplicationActionsMock({ saveGitHubConfiguration: vi.fn().mockRejectedValue(new Error("Settings changed")) })
  const page = (current: typeof source) => <><Toaster /><GitHubPage source={current} actions={actions} /></>
  const view = render(page(source))
  await user.click(screen.getByRole("checkbox", { name: "All repositories for dev" }))
  await waitFor(() => expect(failure).toHaveBeenCalled())
  const retry = failure.mock.calls.find(([id]) => id === "github-apply:dev")![2]!.retry!
  if (removedFirst) {
    const removed = structuredClone(source)
    removed.workspaces = removed.workspaces.filter(workspace => workspace.machine.name !== "dev")
    removed.github.workspaces = removed.github.workspaces!.filter(policy => policy.workspace !== "dev")
    removed.github.workspaceOperations = []
    removed.github.policyRevision = 11
    view.rerender(page(removed))
  }
  const replacement = structuredClone(source)
  replacement.workspaces = replacement.workspaces.map(workspace => workspace.machine.name === "dev"
    ? { ...workspace, machine: { ...workspace.machine, id: "00000000-0000-4000-8000-000000000099" } } : workspace)
  replacement.github.policyRevision = 12
  replacement.github.workspaceOperations = []
  view.rerender(page(replacement))
  await act(async () => retry())
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledOnce()
  expect(actions.retryGitHubConfiguration).not.toHaveBeenCalled()
  expect(screen.getByRole("checkbox", { name: "All repositories for dev" })).not.toBeChecked()
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument())
})

it("discards unfinished author text when the sandbox ID changes without a policy change", async () => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running", "connected")
  const actions = createApplicationActionsMock()
  const view = render(<GitHubPage source={source} actions={actions} />)
  await user.clear(screen.getByLabelText("Git name for dev"))
  await user.type(screen.getByLabelText("Git name for dev"), "Unfinished old author")
  const replacement = structuredClone(source)
  replacement.workspaces = replacement.workspaces.map(workspace => workspace.machine.name === "dev"
    ? { ...workspace, machine: { ...workspace.machine, id: "00000000-0000-4000-8000-000000000099" } } : workspace)
  view.rerender(<GitHubPage source={replacement} actions={actions} />)
  expect(screen.getByLabelText("Git name for dev")).toHaveValue(source.github.workspaces!.find(policy => policy.workspace === "dev")!.identity.name)
  expect(actions.saveGitHubConfiguration).not.toHaveBeenCalled()
})
