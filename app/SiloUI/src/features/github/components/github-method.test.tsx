import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { GitHubAccessEditor } from "./github-access-editor"

it("defaults to OAuth, gates each connection independently, and hides OAuth restrictions for tokens", async () => {
  const user = userEvent.setup()
  const change = vi.fn()
  const props = {
    computers: [{ name: "dev" }], connectionState: "connected" as const,
    tokenConnected: false, repositoryOptions: [], computerSelections: {}, computerIdentities: {},
    currentDeviceGitIdentity: null, onConnect: vi.fn(), onComputerSelectionsChange: vi.fn(),
    onComputerIdentityChange: vi.fn(), onResetComputerIdentity: vi.fn(),
    onComputerRepositoryAccessChange: change,
  }
  const { rerender } = render(<GitHubAccessEditor {...props} />)
  expect(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" })).toBeChecked()
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeDisabled()
  await user.hover(screen.getByText("Use token", { exact: true }))
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Full token access.")
  await user.unhover(screen.getByText("Use token", { exact: true }))
  rerender(<GitHubAccessEditor {...props} connectionState="disconnected" tokenConnected />)
  expect(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" })).toBeDisabled()
  await user.click(screen.getByRole("radio", { name: "Use token for dev" }))
  expect(change).toHaveBeenCalledWith("dev", expect.objectContaining({ authenticationMethod: "token" }))
  rerender(<GitHubAccessEditor {...props} tokenConnected computerRepositoryAccess={{ dev: {
    authenticationMethod: "token", repositoryMode: "all", allRepositoriesAllowChanges: true,
  } }} />)
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
  expect(screen.queryByRole("checkbox", { name: "All repositories for dev" })).not.toBeInTheDocument()
  rerender(<GitHubAccessEditor {...props} computerRepositoryAccess={{ dev: {
    authenticationMethod: "token", repositoryMode: "all", allRepositoriesAllowChanges: true,
  } }} />)
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeDisabled()
  expect(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" })).not.toBeChecked()
})
