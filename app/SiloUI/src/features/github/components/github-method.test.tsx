import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { GitHubAccessEditor } from "./github-access-editor"

it("defaults to OAuth, gates each connection independently, and hides OAuth restrictions for tokens", async () => {
  const user = userEvent.setup()
  const change = vi.fn()
  const props = {
    workspaces: [{ name: "dev" }], connectionState: "connected" as const,
    tokenConnected: false, repositoryOptions: [], workspaceSelections: {}, workspaceIdentities: {},
    currentHostGitIdentity: null, onConnect: vi.fn(), onWorkspaceSelectionsChange: vi.fn(),
    onWorkspaceIdentityChange: vi.fn(), onResetWorkspaceIdentity: vi.fn(),
    onWorkspaceRepositoryAccessChange: change,
  }
  const { rerender } = render(<GitHubAccessEditor {...props} />)
  expect(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" })).toBeChecked()
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeDisabled()
  rerender(<GitHubAccessEditor {...props} connectionState="disconnected" tokenConnected />)
  expect(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" })).toBeDisabled()
  await user.click(screen.getByRole("radio", { name: "Use token for dev" }))
  expect(change).toHaveBeenCalledWith("dev", expect.objectContaining({ authenticationMethod: "token" }))
  rerender(<GitHubAccessEditor {...props} tokenConnected workspaceRepositoryAccess={{ dev: {
    authenticationMethod: "token", repositoryMode: "all", allRepositoriesAllowChanges: true,
  } }} />)
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
  expect(screen.queryByRole("checkbox", { name: "All repositories for dev" })).not.toBeInTheDocument()
  rerender(<GitHubAccessEditor {...props} workspaceRepositoryAccess={{ dev: {
    authenticationMethod: "token", repositoryMode: "all", allRepositoriesAllowChanges: true,
  } }} />)
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeDisabled()
  expect(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" })).not.toBeChecked()
})
