import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import type { ApplicationActions, ApplicationSource, ComputerConfigurationOperation } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

async function addComputer(user: ReturnType<typeof userEvent.setup>) {
  const overview = within(screen.getByRole("region", { name: "Computers" }))
  await user.click(overview.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New computer" }))
  const name = overview.getByRole("textbox", { name: "Computer name" })
  await user.clear(name)
  await user.type(name, "scratch")
  await user.click(overview.getByRole("button", { name: "Create" }))
}

function failedOperation(source: ApplicationSource, message: string): ComputerConfigurationOperation {
  return {
    id: "other-change", status: "failed", result: null, progressEvents: [],
    candidate: { schemaVersion: 1, computers: source.computers.map(({ configuration }) => configuration) },
    error: { code: "native_bridge_failed", computer: null, message, recovery: null, retryable: true },
  }
}

it("clears the optimistic applying state once a save settles, even without a new snapshot", async () => {
  const user = userEvent.setup()
  let finish!: () => void
  const saveComputerConfiguration = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  render(<ApplicationPreview source={applicationSourceForScenario("running")} actions={{ saveComputerConfiguration } as Partial<ApplicationActions>} />)
  await addComputer(user)
  expect(screen.getByText(/Applying computer changes/)).toBeVisible()
  // A no-op change resolves without publishing a new operation.
  await act(async () => finish())
  await waitFor(() => expect(screen.queryByText(/Applying computer changes/)).not.toBeInTheDocument())
  expect(within(screen.getByRole("region", { name: "Computers" })).getByRole("button", { name: "Add" })).toBeEnabled()
})

it("restores the latest reported operation, not the one from when the save began, after a late rejection", async () => {
  const user = userEvent.setup()
  let reject!: (cause: unknown) => void
  const saveComputerConfiguration = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  const actions = { saveComputerConfiguration } as Partial<ApplicationActions>
  const source = structuredClone(applicationSourceForScenario("running"))
  const view = render(<ApplicationPreview source={source} actions={actions} />)
  await addComputer(user)
  expect(screen.getByText(/Applying computer changes/)).toBeVisible()

  // While the save waits, the native side reports a different operation.
  view.rerender(<ApplicationPreview source={{ ...source, computerConfigurationOperation: failedOperation(source, "Another change failed.") }} actions={actions} />)
  expect(screen.getAllByText("Another change failed.").length).toBeGreaterThan(0)

  await act(async () => reject(new Error("The computer changed while your edit was waiting. Review the latest settings.")))
  expect(screen.getAllByText("Another change failed.").length).toBeGreaterThan(0)
  expect(screen.queryByText(/Applying computer changes/)).not.toBeInTheDocument()
})

it("keeps an optimistic push when only the configuration operation changes", async () => {
  const user = userEvent.setup()
  const pushRepository = vi.fn()
  const actions = { pushRepository } as Partial<ApplicationActions>
  const source = structuredClone(applicationSourceForScenario("running"))
  source.repositoryPushOperations = []
  const view = render(<ApplicationPreview source={source} actions={actions} initialRoute={{ computerSection: "files" }} />)
  await user.click(screen.getByRole("button", { name: "Push 2 commits for acme/silo in dev" }))
  expect(pushRepository).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: /^Push$/ }))
  expect(pushRepository).toHaveBeenCalledOnce()
  expect(screen.getByText("Pushing 2 commits…")).toBeVisible()

  view.rerender(<ApplicationPreview source={{ ...source, computerConfigurationOperation: failedOperation(source, "Another change failed.") }} actions={actions} initialRoute={{ computerSection: "files" }} />)
  expect(screen.getByText("Pushing 2 commits…")).toBeVisible()
})
