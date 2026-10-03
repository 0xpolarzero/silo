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
  return within(within(screen.getByRole("navigation", { name: "Silo navigation" })).getByRole("group", { name: "Computer sections" }))
}

it.each(["succeeded", "failed"])("settles a lifecycle toast after %s while viewing Files", async outcome => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.state = "stopped"
  const actions = createApplicationActionsMock()
  const user = userEvent.setup()
  const view = render(<ApplicationPreview source={source} actions={actions} />)
  await user.click(screen.getByRole("button", { name: "Start dev" }))
  expect(actions.startComputer).toHaveBeenCalledWith("dev")

  const running = structuredClone(source)
  running.computers.find(item => item.configuration.id === computer.configuration.id)!.lifecycleAction = "start"
  view.rerender(<ApplicationPreview source={running} actions={actions} />)
  const id = `lifecycle::${computer.configuration.id}`
  await waitFor(() => expect(showOperationProgress).toHaveBeenCalledWith(id, expect.objectContaining({ title: "Starting dev" })), { timeout: 2000 })
  await user.click(sections().getByRole("button", { name: "Files" }))
  vi.mocked(dismissOperationToast).mockClear()

  const finished = structuredClone(source)
  const result = finished.computers.find(item => item.configuration.id === computer.configuration.id)!
  if (outcome === "failed") {
    result.lifecycleFailureAction = "start"
    result.lifecycleFailure = "Start failed"
  } else result.state = "running"
  view.rerender(<ApplicationPreview source={finished} actions={actions} />)
  if (outcome === "failed") {
    await waitFor(() => expect(showOperationFailure).toHaveBeenCalledWith(id, "Could not start dev", expect.objectContaining({ retry: expect.any(Function) })))
    const options = vi.mocked(showOperationFailure).mock.calls.find(call => call[0] === id)![2]!
    act(() => options.retry!())
    expect(actions.startComputer).toHaveBeenCalledTimes(2)
  } else await waitFor(() => expect(dismissOperationToast).toHaveBeenCalledWith(id))
  vi.mocked(showOperationProgress).mockClear()
  await user.click(sections().getByRole("button", { name: "All computers" }))
  expect(vi.mocked(showOperationProgress).mock.calls.some(call => call[0] === id)).toBe(false)
})

it.each(["succeeded", "failed"] as const)("settles a repository push toast after %s while viewing Computers", async outcome => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  const target = { repository: "acme/silo", branch: "main", commit: "4f1c2d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d" }
  const push = { computer: "dev", repositoryPath: "acme/silo", commitCount: 2, target, status: "pushing" as const }
  source.repositoryPushOperations = [push]
  const dismissRepositoryPush = vi.fn()
  const actions = createApplicationActionsMock({ dismissRepositoryPush })
  const initialRoute = { computerSection: "files" as const }
  const user = userEvent.setup()
  const view = render(<ApplicationPreview source={source} actions={actions} initialRoute={initialRoute} />)
  const id = "repository-push:dev:acme/silo"
  await waitFor(() => expect(showOperationProgress).toHaveBeenCalledWith(id, expect.objectContaining({ title: "Pushing 2 commits" })))
  await user.click(sections().getByRole("button", { name: "All computers" }))
  const finished = { ...source, repositoryPushOperations: [{ ...push, status: outcome, message: "Push failed" }] }
  view.rerender(<ApplicationPreview source={finished} actions={actions} initialRoute={initialRoute} />)
  if (outcome === "failed") {
    await waitFor(() => expect(showOperationFailure).toHaveBeenCalledWith(id, "Push failed · silo", expect.objectContaining({ retry: expect.any(Function) })))
    const options = vi.mocked(showOperationFailure).mock.calls.find(call => call[0] === id)![2]!
    act(() => options.retry!())
    expect(actions.pushRepository).toHaveBeenCalledWith(computer.configuration.name, push.repositoryPath, target)
  } else {
    await waitFor(() => expect(showOperationSuccess).toHaveBeenCalledWith(id, "Pushed 2 commits · silo", expect.any(Object)))
    expect(dismissRepositoryPush).toHaveBeenCalledWith("dev", "acme/silo")
  }
})
