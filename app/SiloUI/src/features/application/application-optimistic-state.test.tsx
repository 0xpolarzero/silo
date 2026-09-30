import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import type { ApplicationActions, ApplicationSource, SandboxConfigurationOperation } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

async function addSandbox(user: ReturnType<typeof userEvent.setup>) {
  const overview = within(screen.getByRole("region", { name: "Sandboxes" }))
  await user.click(overview.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  const name = overview.getByRole("textbox", { name: "Sandbox name" })
  await user.clear(name)
  await user.type(name, "scratch")
  await user.click(overview.getByRole("button", { name: "Save" }))
}

function failedOperation(source: ApplicationSource, message: string): SandboxConfigurationOperation {
  return {
    id: "other-change", status: "failed", result: null, progressEvents: [],
    candidate: { schemaVersion: 1, machines: source.workspaces.map(({ machine }) => machine) },
    error: { code: "native_bridge_failed", workspace: null, message, recovery: null, retryable: true },
  }
}

it("clears the optimistic applying state once a save settles, even without a new snapshot", async () => {
  const user = userEvent.setup()
  let finish!: () => void
  const saveMachineConfiguration = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  render(<ApplicationPreview source={applicationSourceForScenario("running")} actions={{ saveMachineConfiguration } as Partial<ApplicationActions>} />)
  await addSandbox(user)
  expect(screen.getByText(/Applying sandbox changes/)).toBeVisible()
  // A no-op change resolves without publishing a new operation.
  await act(async () => finish())
  await waitFor(() => expect(screen.queryByText(/Applying sandbox changes/)).not.toBeInTheDocument())
  expect(within(screen.getByRole("region", { name: "Sandboxes" })).getByRole("button", { name: "Add" })).toBeEnabled()
})

it("restores the latest reported operation, not the one from when the save began, after a late rejection", async () => {
  const user = userEvent.setup()
  let reject!: (cause: unknown) => void
  const saveMachineConfiguration = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  const actions = { saveMachineConfiguration } as Partial<ApplicationActions>
  const source = structuredClone(applicationSourceForScenario("running"))
  const view = render(<ApplicationPreview source={source} actions={actions} />)
  await addSandbox(user)
  expect(screen.getByText(/Applying sandbox changes/)).toBeVisible()

  // While the save waits, the native side reports a different operation.
  view.rerender(<ApplicationPreview source={{ ...source, sandboxConfigurationOperation: failedOperation(source, "Another change failed.") }} actions={actions} />)
  expect(screen.getAllByText("Another change failed.").length).toBeGreaterThan(0)

  await act(async () => reject(new Error("The sandbox changed while your edit was waiting. Review the latest settings.")))
  expect(screen.getAllByText("Another change failed.").length).toBeGreaterThan(0)
  expect(screen.queryByText(/Applying sandbox changes/)).not.toBeInTheDocument()
})

it("keeps an optimistic push when only the configuration operation changes", async () => {
  const user = userEvent.setup()
  const pushRepository = vi.fn()
  const actions = { pushRepository } as Partial<ApplicationActions>
  const source = structuredClone(applicationSourceForScenario("running"))
  source.repositoryPushOperations = []
  const view = render(<ApplicationPreview source={source} actions={actions} initialRoute={{ workspaceSection: "files" }} />)
  await user.click(screen.getByRole("button", { name: "Push 2 commits for acme/silo in dev" }))
  expect(pushRepository).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: /^Push$/ }))
  expect(pushRepository).toHaveBeenCalledOnce()
  expect(screen.getByText("Pushing 2 commits…")).toBeVisible()

  view.rerender(<ApplicationPreview source={{ ...source, sandboxConfigurationOperation: failedOperation(source, "Another change failed.") }} actions={actions} initialRoute={{ workspaceSection: "files" }} />)
  expect(screen.getByText("Pushing 2 commits…")).toBeVisible()
})
