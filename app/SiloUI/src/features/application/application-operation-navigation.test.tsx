import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import { dismissOperationToast, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"

vi.mock("@/lib/operation-toast", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operation-toast")>(),
  dismissOperationToast: vi.fn(),
  showOperationFailure: vi.fn(),
  showOperationProgress: vi.fn(),
  showOperationSuccess: vi.fn(),
}))

beforeEach(() => { vi.clearAllMocks() })

function sections() {
  return within(within(screen.getByRole("navigation", { name: "Silo navigation" })).getByRole("group", { name: "Sandbox sections" }))
}

it.each(["succeeded", "failed"])("settles a lifecycle toast after %s while viewing Files", async outcome => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.state = "stopped"
  const actions = createApplicationActionsMock()
  const user = userEvent.setup()
  const view = render(<ApplicationPreview source={source} actions={actions} />)
  await user.click(screen.getByRole("button", { name: "Start dev" }))
  expect(actions.startWorkspace).toHaveBeenCalledWith("dev")

  const running = structuredClone(source)
  running.workspaces.find(item => item.machine.id === workspace.machine.id)!.lifecycleAction = "start"
  view.rerender(<ApplicationPreview source={running} actions={actions} />)
  const id = `lifecycle::${workspace.machine.id}`
  await waitFor(() => expect(showOperationProgress).toHaveBeenCalledWith(id, expect.objectContaining({ title: "Starting dev" })), { timeout: 2000 })
  await user.click(sections().getByRole("button", { name: "Files" }))
  vi.mocked(dismissOperationToast).mockClear()

  const finished = structuredClone(source)
  const result = finished.workspaces.find(item => item.machine.id === workspace.machine.id)!
  if (outcome === "failed") {
    result.lifecycleFailureAction = "start"
    result.lifecycleFailure = "Start failed"
  } else result.state = "running"
  view.rerender(<ApplicationPreview source={finished} actions={actions} />)
  if (outcome === "failed") {
    await waitFor(() => expect(showOperationFailure).toHaveBeenCalledWith(id, "Could not start dev", expect.objectContaining({ retry: expect.any(Function) })))
    const options = vi.mocked(showOperationFailure).mock.calls.find(call => call[0] === id)![2]!
    act(() => options.retry!())
    expect(actions.startWorkspace).toHaveBeenCalledTimes(2)
  } else await waitFor(() => expect(dismissOperationToast).toHaveBeenCalledWith(id))
  vi.mocked(showOperationProgress).mockClear()
  await user.click(sections().getByRole("button", { name: "All sandboxes" }))
  expect(vi.mocked(showOperationProgress).mock.calls.some(call => call[0] === id)).toBe(false)
})

it.each(["succeeded", "failed"] as const)("settles a repository push toast after %s while viewing Sandboxes", async outcome => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  const target = { repository: "acme/silo", branch: "main", commit: "4f1c2d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d" }
  const push = { workspace: "dev", repositoryPath: "acme/silo", commitCount: 2, target, status: "pushing" as const }
  source.repositoryPushOperations = [push]
  const dismissRepositoryPush = vi.fn()
  const actions = createApplicationActionsMock({ dismissRepositoryPush })
  const initialRoute = { workspaceSection: "files" as const }
  const user = userEvent.setup()
  const view = render(<ApplicationPreview source={source} actions={actions} initialRoute={initialRoute} />)
  const id = "repository-push:dev:acme/silo"
  await waitFor(() => expect(showOperationProgress).toHaveBeenCalledWith(id, expect.objectContaining({ title: "Pushing 2 commits" })))
  await user.click(sections().getByRole("button", { name: "All sandboxes" }))
  const finished = { ...source, repositoryPushOperations: [{ ...push, status: outcome, message: "Push failed" }] }
  view.rerender(<ApplicationPreview source={finished} actions={actions} initialRoute={initialRoute} />)
  if (outcome === "failed") {
    await waitFor(() => expect(showOperationFailure).toHaveBeenCalledWith(id, "Push failed · silo", expect.objectContaining({ retry: expect.any(Function) })))
    const options = vi.mocked(showOperationFailure).mock.calls.find(call => call[0] === id)![2]!
    act(() => options.retry!())
    expect(actions.pushRepository).toHaveBeenCalledWith(workspace.machine.name, push.repositoryPath, target)
  } else {
    await waitFor(() => expect(showOperationSuccess).toHaveBeenCalledWith(id, "Pushed 2 commits · silo", expect.any(Object)))
    expect(dismissRepositoryPush).toHaveBeenCalledWith("dev", "acme/silo")
  }
})
