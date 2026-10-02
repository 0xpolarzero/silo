import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import { GitHubPage } from "./github-page"

it.each(["name", "email"])("saves disabling the Git identity after clearing its %s", async (field) => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running", "connected")
  source.github.policyRevision = 10
  const actions = createApplicationActionsMock()
  const view = render(<GitHubPage source={source} actions={actions} />)
  await user.clear(screen.getByLabelText(`Git ${field} for dev`))
  await user.click(screen.getByRole("checkbox", { name: "Apply Git identity to dev" }))
  await waitFor(() => expect(actions.saveGitHubConfiguration).toHaveBeenCalledOnce())
  const [saved] = vi.mocked(actions.saveGitHubConfiguration!).mock.calls[0]
  expect(saved.workspaces).toEqual([expect.objectContaining({
    workspace: "dev", identity: expect.objectContaining({ [field]: "", apply: false }),
  })])
  const refreshed = structuredClone(source)
  refreshed.github.policyRevision = 11
  refreshed.github.workspaces = source.github.workspaces!.map(policy => policy.workspace === "dev" ? saved.workspaces[0] : policy)
  view.rerender(<GitHubPage source={refreshed} actions={actions} />)
  expect(screen.getByRole("checkbox", { name: "Apply Git identity to dev" })).not.toBeChecked()
  expect(screen.getByLabelText(`Git ${field} for dev`)).toHaveValue("")
})
