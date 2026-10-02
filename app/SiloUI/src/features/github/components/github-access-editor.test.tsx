import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { GitHubAccessEditor } from "@/features/github/components/github-access-editor"
import { GitHubPage } from "@/features/application/pages/github-page"
import type { ApplicationActions } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

describe("GitHubAccessEditor", () => {
  it.each([{ repositoryOptions: [] }, { repositoryOptions: ["acme/silo"] }])("excludes repository suggestions and GitHub authorization from the page Tab order (%j)", async ({ repositoryOptions }) => {
    const user = userEvent.setup()
    render(<GitHubAccessEditor
      workspaces={[{ name: "dev" }]} connectionState="connected"
      repositoryOptions={repositoryOptions} workspaceSelections={{}} workspaceIdentities={{}}
      currentHostGitIdentity={null} onConnect={vi.fn()}
      onWorkspaceSelectionsChange={vi.fn()} onWorkspaceIdentityChange={vi.fn()} onResetWorkspaceIdentity={vi.fn()}
      onManageRepositories={vi.fn()}
    />)
    await user.click(screen.getByRole("combobox", { name: "Add repository to dev" }))
    expect(screen.getAllByRole("option")).toHaveLength(repositoryOptions.length + 1)
    await user.tab()
    expect(document.activeElement).toBe(document.body)
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("uses empty defaults for an incoming sandbox named constructor", () => {
    const props = {
      workspaces: [{ name: "dev" }], connectionState: "connected" as const,
      repositoryOptions: ["acme/silo"], workspaceSelections: { dev: [] }, workspaceIdentities: {},
      currentHostGitIdentity: null, onConnect: vi.fn(), onWorkspaceSelectionsChange: vi.fn(),
      onWorkspaceIdentityChange: vi.fn(), onResetWorkspaceIdentity: vi.fn(),
      onWorkspaceRepositoryAccessChange: vi.fn(),
    }
    const view = render(<GitHubAccessEditor {...props} />)
    view.rerender(<GitHubAccessEditor {...props} workspaces={[{ name: "dev" }, { name: "constructor" }]} />)
    expect(screen.getByLabelText("Git name for constructor")).toHaveValue("")
    expect(screen.getByLabelText("Git email for constructor")).toHaveValue("")
    expect(screen.getByRole("checkbox", { name: "All repositories for constructor" })).not.toBeChecked()
    expect(screen.getByRole("combobox", { name: "Add repository to constructor" })).toBeEnabled()
    expect(screen.queryByRole("table", { name: "Selected repositories for constructor" })).not.toBeInTheDocument()
  })

  it("uses saved GitHub settings for a sandbox named constructor", () => {
    render(<GitHubAccessEditor
      workspaces={[{ name: "constructor" }]} connectionState="connected"
      repositoryOptions={["acme/silo"]}
      workspaceSelections={{ constructor: [{ repository: "acme/silo", allowPushes: true }] }}
      workspaceIdentities={{ constructor: { name: "Taylor", email: "taylor@example.com", apply: false } }}
      workspaceRepositoryAccess={{ constructor: { repositoryMode: "selected" as const, allRepositoriesAllowChanges: false } }}
      currentHostGitIdentity={null} onConnect={vi.fn()}
      onWorkspaceSelectionsChange={vi.fn()} onWorkspaceIdentityChange={vi.fn()} onResetWorkspaceIdentity={vi.fn()}
      onWorkspaceRepositoryAccessChange={vi.fn()}
    />)
    expect(screen.getByLabelText("Git name for constructor")).toHaveValue("Taylor")
    expect(screen.getByLabelText("Git email for constructor")).toHaveValue("taylor@example.com")
    expect(screen.getByRole("checkbox", { name: "Apply Git identity to constructor" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" })).toBeChecked()
  })

  it("accepts a newly discovered constructor sandbox before the page draft catches up", () => {
    const source = applicationSourceForScenario("running", "connected")
    const actions = {} as ApplicationActions
    const view = render(<GitHubPage source={source} actions={actions} />)
    const workspace = source.workspaces.find(item => !item.computer)!
    const incoming = { ...source, workspaces: [...source.workspaces, {
      ...workspace, machine: { ...workspace.machine, name: "constructor", id: "new-constructor" },
    }] }
    view.rerender(<GitHubPage source={incoming} actions={actions} />)
    expect(screen.getByLabelText("Git name for constructor")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Add repository to constructor" })).toBeEnabled()
  })

  it("keeps the highlighted repository when the catalog order changes", async () => {
    const user = userEvent.setup()
    const onSelections = vi.fn()
    const props = {
      workspaces: [{ name: "dev" }], connectionState: "connected" as const,
      repositoryOptions: ["acme/base", "acme/silo"], workspaceSelections: {}, workspaceIdentities: {},
      currentHostGitIdentity: null, onConnect: vi.fn(), onWorkspaceSelectionsChange: onSelections,
      onWorkspaceIdentityChange: vi.fn(), onResetWorkspaceIdentity: vi.fn(),
    }
    const view = render(<GitHubAccessEditor {...props} />)
    await user.click(screen.getByRole("combobox"))
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("option", { name: "acme/silo" })).toHaveAttribute("aria-selected", "true")
    view.rerender(<GitHubAccessEditor {...props} repositoryOptions={["acme/base", "acme/other", "acme/silo"]} />)
    await user.keyboard("{Enter}")
    expect(onSelections).toHaveBeenCalledExactlyOnceWith("dev", [{ repository: "acme/silo", allowPushes: false }])
  })

  it("does not add a different repository when the highlighted result disappears", async () => {
    const user = userEvent.setup()
    const onSelections = vi.fn()
    const props = {
      workspaces: [{ name: "dev" }], connectionState: "connected" as const,
      repositoryOptions: ["acme/silo", "acme/other"], workspaceSelections: {}, workspaceIdentities: {},
      currentHostGitIdentity: null, onConnect: vi.fn(), onWorkspaceSelectionsChange: onSelections,
      onWorkspaceIdentityChange: vi.fn(), onResetWorkspaceIdentity: vi.fn(),
    }
    const view = render(<GitHubAccessEditor {...props} />)
    await user.click(screen.getByRole("combobox"))
    view.rerender(<GitHubAccessEditor {...props} repositoryOptions={["acme/other"]} />)
    await user.keyboard("{Enter}")
    expect(onSelections).not.toHaveBeenCalled()
    expect(screen.getByRole("combobox")).not.toHaveAttribute("aria-activedescendant")
    await user.keyboard("{ArrowDown}{Enter}")
    expect(onSelections).toHaveBeenCalledExactlyOnceWith("dev", [{ repository: "acme/other", allowPushes: false }])
  })

  it("keeps GitHub authorization highlighted when repository results change", async () => {
    const user = userEvent.setup()
    const onSelections = vi.fn()
    const onManage = vi.fn()
    const props = {
      workspaces: [{ name: "dev" }], connectionState: "connected" as const,
      repositoryOptions: ["acme/silo"], workspaceSelections: {}, workspaceIdentities: {},
      currentHostGitIdentity: null, onConnect: vi.fn(), onWorkspaceSelectionsChange: onSelections,
      onWorkspaceIdentityChange: vi.fn(), onResetWorkspaceIdentity: vi.fn(), onManageRepositories: onManage,
    }
    const view = render(<GitHubAccessEditor {...props} />)
    await user.click(screen.getByRole("combobox"))
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("option", { name: "Add more repositories on GitHub" })).toHaveAttribute("aria-selected", "true")
    view.rerender(<GitHubAccessEditor {...props} repositoryOptions={["acme/silo", "acme/other"]} />)
    await user.keyboard("{Enter}")
    expect(onManage).toHaveBeenCalledOnce()
    expect(onSelections).not.toHaveBeenCalled()
  })

  it("offers repository authorization as the final search item, including empty results", async () => {
    const user = userEvent.setup()
    const onManageRepositories = vi.fn()
    render(<GitHubAccessEditor
      workspaces={[{ name: "dev" }]} connectionState="connected"
      repositoryOptions={["acme/silo"]} workspaceSelections={{}} workspaceIdentities={{}}
      currentHostGitIdentity={null} onConnect={vi.fn()}
      onWorkspaceSelectionsChange={vi.fn()} onWorkspaceIdentityChange={vi.fn()} onResetWorkspaceIdentity={vi.fn()}
      onManageRepositories={onManageRepositories}
    />)
    expect(screen.queryByRole("option", { name: "Add more repositories on GitHub" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("combobox"))
    expect(screen.getAllByRole("option").at(-1)).toHaveTextContent("Add more repositories on GitHub")
    await user.keyboard("{ArrowDown}{Enter}")
    expect(onManageRepositories).toHaveBeenCalledOnce()
    onManageRepositories.mockClear()
    await user.type(screen.getByRole("combobox"), "missing-repository")
    expect(screen.getByText("No repositories found.")).toBeVisible()
    await user.click(screen.getByRole("option", { name: "Add more repositories on GitHub" }))
    expect(onManageRepositories).toHaveBeenCalledOnce()
    await user.click(screen.getByRole("combobox"))
    expect(screen.queryByRole("option", { name: "Refresh repositories" })).not.toBeInTheDocument()
  })

  it("chooses all current and future authorized repositories with changes off by default", async () => {
    const user = userEvent.setup()
    const onAccess = vi.fn()
    const props = {
      workspaces: [{ name: "dev" }], connectionState: "connected" as const,
      repositoryOptions: ["acme/silo"], workspaceSelections: { dev: [{ repository: "acme/silo", allowPushes: true }] },
      workspaceIdentities: {}, currentHostGitIdentity: null,
      onConnect: vi.fn(), onWorkspaceSelectionsChange: vi.fn(), onWorkspaceIdentityChange: vi.fn(), onResetWorkspaceIdentity: vi.fn(),
      onWorkspaceRepositoryAccessChange: onAccess,
    }
    const { rerender } = render(<GitHubAccessEditor {...props} />)
    await user.click(screen.getByRole("checkbox", { name: "All repositories for dev" }))
    expect(onAccess).toHaveBeenLastCalledWith("dev", { repositoryMode: "all", allRepositoriesAllowChanges: false })
    rerender(<GitHubAccessEditor {...props} workspaceRepositoryAccess={{ dev: { repositoryMode: "all", allRepositoriesAllowChanges: false } }} />)
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.getByText("All repositories authorized on GitHub, including future additions.")).toBeVisible()
    await user.click(screen.getByRole("checkbox", { name: "Allow GitHub changes for all repositories in dev" }))
    expect(onAccess).toHaveBeenLastCalledWith("dev", { repositoryMode: "all", allRepositoriesAllowChanges: true })
    expect(props.onWorkspaceSelectionsChange).not.toHaveBeenCalled()
    rerender(<GitHubAccessEditor {...props} workspaceRepositoryAccess={{ dev: { repositoryMode: "selected", allRepositoriesAllowChanges: false } }} />)
    expect(screen.getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" })).toBeChecked()
  })

  it("supports app extensions and makes a disabled editor readable but immutable", () => {
    render(
      <GitHubAccessEditor
        workspaces={[{ name: "dev" }]}
        connectionState="connected"
        repositoryOptions={["acme/silo", "acme/design-system"]}
        workspaceSelections={{ dev: [{ repository: "acme/silo", allowPushes: true }] }}
        workspaceIdentities={{ dev: { name: "Taylor Example", email: "taylor@example.com", apply: true } }}
        currentHostGitIdentity={{ name: "Taylor Example", email: "taylor@example.com" }}
        onConnect={vi.fn()}
        onWorkspaceSelectionsChange={vi.fn()}
        onWorkspaceIdentityChange={vi.fn()}
        onResetWorkspaceIdentity={vi.fn()}
        connectedTitle="Connected as @taylor"
        connectedDetail="Private repositories are available."
        connectedActions={<button type="button">Disconnect</button>}
        notice={<p>GitHub access is paused.</p>}
        renderWorkspaceActions={({ name }) => <button type="button">Disable {name} access</button>}
        footer={<div role="status">Unsaved changes</div>}
        disabled
      />,
    )

    expect(screen.getByRole("heading", { name: "Connected as @taylor" })).toBeVisible()
    expect(screen.getByText("Private repositories are available.")).toBeVisible()
    expect(screen.getByText("GitHub access is paused.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Disable dev access" })).toBeEnabled()
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes")

    const editor = screen.getByRole("region", { name: "Sandbox Git identity and repository access" })
    expect(within(editor).getByLabelText("Git name for dev")).toBeDisabled()
    expect(within(editor).getByLabelText("Git email for dev")).toBeDisabled()
    expect(within(editor).getByRole("checkbox", { name: "Apply Git identity to dev" })).toBeDisabled()
    expect(within(editor).getByRole("button", { name: "Reset Git identity for dev" })).toBeDisabled()
    expect(within(editor).getByRole("combobox", { name: "Add repository to dev" })).toBeDisabled()
    expect(within(editor).getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" })).toBeDisabled()
    expect(within(editor).getByRole("button", { name: "Clear repositories from dev" })).toBeDisabled()
    expect(within(editor).getByRole("button", { name: "Remove acme/silo from dev" })).toBeDisabled()
  })

  it("collapses sandbox sections independently while leaving them expanded initially", async () => {
    const user = userEvent.setup()
    render(
      <GitHubAccessEditor
        workspaces={[{ name: "dev" }, { name: "playgrounds" }]}
        connectionState="connected"
        repositoryOptions={["acme/silo"]}
        workspaceSelections={{ dev: [{ repository: "acme/silo", allowPushes: true }], playgrounds: [] }}
        workspaceIdentities={{
          dev: { name: "Taylor Example", email: "taylor@example.com", apply: true },
          playgrounds: { name: "Taylor Example", email: "taylor@example.com", apply: true },
        }}
        currentHostGitIdentity={{ name: "Taylor Example", email: "taylor@example.com" }}
        onConnect={vi.fn()}
        onWorkspaceSelectionsChange={vi.fn()}
        onWorkspaceIdentityChange={vi.fn()}
        onResetWorkspaceIdentity={vi.fn()}
      />,
    )

    const devDisclosure = screen.getByRole("button", { name: "Collapse dev" })
    const playgroundsDisclosure = screen.getByRole("button", { name: "Collapse playgrounds" })
    expect(devDisclosure).toHaveAttribute("aria-expanded", "true")
    expect(playgroundsDisclosure).toHaveAttribute("aria-expanded", "true")

    await user.click(devDisclosure)
    expect(devDisclosure).toHaveAttribute("aria-expanded", "false")
    expect(devDisclosure).toHaveAccessibleName("Expand dev")
    expect(screen.queryByRole("group", { name: "Git identity for dev" })).not.toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Git identity for playgrounds" })).toBeVisible()

    await user.click(devDisclosure)
    expect(devDisclosure).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("group", { name: "Git identity for dev" })).toBeVisible()
  })
})
