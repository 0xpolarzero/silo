import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import type { ApplicationActions, ApplicationSource } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"



function renderApplication(scenario: Parameters<typeof applicationSourceForScenario>[0] = "running", source?: ApplicationSource) {
  const actions: ApplicationActions = {
    saveSecret: vi.fn(),
    removeSecret: vi.fn(),
    retryRuntimeChecks: vi.fn(),
    saveMachineConfiguration: vi.fn(),
    dismissMachineConfigurationError: vi.fn(),
    retryMachineConfiguration: vi.fn(),
    pushRepository: vi.fn(),
    startWorkspace: vi.fn(),
    stopWorkspace: vi.fn(),
    restartWorkspace: vi.fn(),
    dismissWorkspaceError: vi.fn(),
    openTerminal: vi.fn(),
    openEditor: vi.fn(),
    connectGitHub: vi.fn(),
    cancelGitHubConnection: vi.fn(),
    reopenGitHubAuthorization: vi.fn(),
    disconnectGitHub: vi.fn(),
    setGitHubAccessEnabled: vi.fn(),
    saveGitHubConfiguration: vi.fn(),
    retryGitHubConfiguration: vi.fn(),
    retryGitHubRepositoryCatalog: vi.fn(),
  }

  return {
    actions,
    user: userEvent.setup(),
    ...render(<ApplicationPreview source={source ?? applicationSourceForScenario(scenario)} actions={actions} />),
  }
}

function appNavigation() {
  return screen.getByRole("navigation", { name: "Silo navigation" })
}

function appPanel(name: string) {
  return screen.getByRole("region", { name })
}


it("reuses the compact onboarding GitHub editor without redundant page framing", async () => {
  const { user } = renderApplication()
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))

  const github = within(appPanel("GitHub"))
  expect(github.queryByRole("heading", { name: "GitHub" })).not.toBeInTheDocument()
  expect(github.queryByText("Manage the account and repository access available inside each sandbox.")).not.toBeInTheDocument()
  expect(github.queryByRole("heading", { name: "Repository access" })).not.toBeInTheDocument()
  expect(github.getByText("Connected as @taylor")).toBeVisible()
  expect(github.getByRole("button", { name: "Disable access" })).toBeVisible()
  expect(github.getByRole("button", { name: "Disconnect" })).toBeVisible()
  expect(github.queryByRole("button", { name: "Clear repositories" })).not.toBeInTheDocument()
  const clearDevRepositories = github.getByRole("button", { name: "Clear repositories from dev" })
  expect(clearDevRepositories).toBeVisible()
  await user.hover(clearDevRepositories)
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Clear repositories from dev")
  await user.unhover(clearDevRepositories)
  expect(github.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument()
  expect(github.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()

  const editor = github.getByRole("region", { name: "Sandbox Git identity and repository access" })
  expect(editor).toBeVisible()
  expect(editor).toHaveClass("min-h-0", "flex-1")
  expect(editor.querySelector(".divide-y")).not.toBeNull()

  for (const workspace of ["dev", "playgrounds", "personal"]) {
    const identity = github.getByRole("group", { name: `Git identity for ${workspace}` })
    expect(identity.closest('[data-slot="card"]')).toBeNull()
    expect(github.getByLabelText(`Git name for ${workspace}`)).toBeVisible()
    expect(github.getByLabelText(`Git email for ${workspace}`)).toBeVisible()
    expect(github.getByRole("checkbox", { name: `Apply Git identity to ${workspace}` })).toBeVisible()
    expect(github.getByRole("button", { name: `Reset Git identity for ${workspace}` })).toBeVisible()
    expect(github.getByRole("combobox", { name: `Add repository to ${workspace}` })).toBeVisible()
  }

  expect(github.getByLabelText("Git name for dev")).toHaveValue("Taylor Example")
  expect(github.getByLabelText("Git email for dev")).toHaveValue("taylor@example.com")
  expect(github.getByRole("checkbox", { name: "Apply Git identity to dev" })).toBeChecked()
  const repositories = github.getByRole("table", { name: "Selected repositories for dev" })
  expect(within(repositories).getAllByRole("columnheader").map(({ textContent }) => textContent)).toEqual([
    "Repository",
    "Allow GitHub changes",
    "",
  ])
  expect(within(repositories).getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" })).toBeChecked()
  expect(within(repositories).getByRole("checkbox", { name: "Allow GitHub changes for acme/design-system" })).not.toBeChecked()
  expect(within(repositories).getByRole("button", { name: "Remove acme/silo from dev" })).toBeVisible()

  const devDisclosure = github.getByRole("button", { name: "Collapse dev" })
  await user.click(devDisclosure)
  expect(devDisclosure).toHaveAttribute("aria-expanded", "false")
  expect(github.queryByRole("group", { name: "Git identity for dev" })).not.toBeInTheDocument()
  expect(github.getByRole("group", { name: "Git identity for playgrounds" })).toBeVisible()
})


it("preserves unsaved Git identity and pending repository choices during source polling", async () => {
  const source = applicationSourceForScenario("running")
  const { actions, user, rerender } = renderApplication("running", source)
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  const name = github.getByLabelText("Git name for dev")
  await user.clear(name)
  await user.type(name, "Unfinished Author")
  rerender(<ApplicationPreview source={structuredClone(source)} actions={actions} />)
  expect(name).toHaveValue("Unfinished Author")
  expect(actions.saveGitHubConfiguration).not.toHaveBeenCalled()
  await user.click(github.getByRole("checkbox", { name: "All repositories for playgrounds" }))
  rerender(<ApplicationPreview source={structuredClone(source)} actions={actions} />)
  expect(github.getByRole("checkbox", { name: "All repositories for playgrounds" })).toBeChecked()
  expect(within(appNavigation()).getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-busy", "true")
})


it.each([false, true])("uses the detected host author for each sandbox missing a policy (partial=%s)", async (partial) => {
  const source = applicationSourceForScenario("running")
  const existing = source.github.workspaces![0]
  source.github.workspaces = partial ? [existing] : []
  source.github.hostIdentity = { name: "Local Author", email: "local@example.test" }
  const { actions, user } = renderApplication("running", source)
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  expect(github.getByLabelText("Git name for playgrounds")).toHaveValue("Local Author")
  expect(github.getByLabelText("Git email for playgrounds")).toHaveValue("local@example.test")
  if (partial) expect(github.getByLabelText("Git name for dev")).toHaveValue(existing.identity.name)
  await user.click(github.getByRole("checkbox", { name: "All repositories for playgrounds" }))
  expect(actions.saveGitHubConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
    workspaces: expect.arrayContaining([expect.objectContaining({ workspace: "playgrounds", repositoryMode: "all", identity: { name: "Local Author", email: "local@example.test", apply: true } })]),
  }))
})


it("allows repository selection without inventing a missing Git identity", async () => {
  const source = applicationSourceForScenario("running")
  source.github.workspaces = []
  source.github.hostIdentity = null
  const { actions, user } = renderApplication("running", source)
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  expect(github.getByLabelText("Git name for dev")).toHaveValue("")
  await user.click(github.getByRole("checkbox", { name: "All repositories for dev" }))
  expect(actions.saveGitHubConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
    workspaces: expect.arrayContaining([expect.objectContaining({ workspace: "dev", repositoryMode: "all", identity: { name: "", email: "", apply: false } })]),
  }))
})


it("does not submit an incomplete author edit with repository changes", async () => {
  const source = applicationSourceForScenario("running")
  const { actions, user } = renderApplication("running", source)
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  await user.clear(github.getByLabelText("Git name for dev"))
  await user.click(github.getByRole("checkbox", { name: "All repositories for playgrounds" }))
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledOnce()
  // Only the changed sandbox is saved, so dev's unfinished author is not submitted.
  const [saved] = vi.mocked(actions.saveGitHubConfiguration!).mock.calls[0]
  expect(saved.workspaces.map(({ workspace }) => workspace)).toEqual(["playgrounds"])
  expect(github.getByLabelText("Git name for dev")).toHaveValue("")
})


it("saves only the edited sandbox against the shown revision and never turns access on", async () => {
  const source = applicationSourceForScenario("running", "connected")
  source.github.policyRevision = 10
  source.github.accessEnabled = false
  const { actions, user } = renderApplication("running", source)
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  const name = github.getByLabelText("Git name for playgrounds")
  await user.clear(name)
  await user.type(name, "Morgan Example")
  await user.tab()
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledOnce()
  const [saved] = vi.mocked(actions.saveGitHubConfiguration!).mock.calls[0]
  // Other sandboxes (such as a fork's copied assignment) keep their saved choices, and a
  // save right after Disable access cannot re-enable it.
  expect(saved).toEqual({
    baseRevision: 10,
    hostIdentity: source.github.hostIdentity ?? null,
    workspaces: [expect.objectContaining({ workspace: "playgrounds", identity: expect.objectContaining({ name: "Morgan Example" }) })],
  })
  expect(saved).not.toHaveProperty("accessEnabled")
})


it("settles a newer GitHub revision even when its completion matches the previous save", async () => {
  const source = applicationSourceForScenario("running", "connected")
  source.github.policyRevision = 10
  source.github.workspaceOperations = [{ workspace: "dev", status: "succeeded", message: "GitHub access verified." }]
  const application = renderApplication("running", source)
  await application.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  await application.user.click(github.getByRole("checkbox", { name: "All repositories for dev" }))
  expect(await screen.findByText("Applying repository access…")).toBeVisible()
  const completed = structuredClone(source)
  completed.github.policyRevision = 11
  completed.github.workspaces = vi.mocked(application.actions.saveGitHubConfiguration!).mock.calls[0][0].workspaces
  application.rerender(<ApplicationPreview source={completed} actions={application.actions} />)
  expect(await screen.findByText("GitHub settings applied")).toBeVisible()
  expect(screen.queryByText("Applying repository access…")).not.toBeInTheDocument()
  expect(github.getByRole("button", { name: "Disable access" })).toBeEnabled()
})


it("stops applying and permits correction when a native GitHub save rejects", async () => {
  const { actions, user } = renderApplication()
  vi.mocked(actions.saveGitHubConfiguration!).mockRejectedValueOnce(new Error("Invalid Git identity settings."))
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  await user.click(github.getByRole("checkbox", { name: "All repositories for dev" }))
  expect(await screen.findByText(/Invalid Git identity settings\./)).toBeVisible()
  expect(screen.queryByText("Applying repository access…")).not.toBeInTheDocument()
  expect(github.getByRole("button", { name: /GitHub settings not applied for dev/ })).toBeVisible()
  expect(github.getByRole("button", { name: "Disable access" })).toBeEnabled()
})


it("ignores a rejected save once a newer repository change is pending", async () => {
  const { actions, user } = renderApplication()
  let rejectFirst!: (cause: Error) => void
  vi.mocked(actions.saveGitHubConfiguration!).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  await user.click(github.getByRole("checkbox", { name: "All repositories for dev" }))
  await user.click(github.getByRole("checkbox", { name: "All repositories for dev" }))
  await act(async () => rejectFirst(new Error("Older request failed")))
  expect(screen.queryByText(/Older request failed/)).not.toBeInTheDocument()
  expect(github.queryByRole("button", { name: /GitHub settings not applied/ })).not.toBeInTheDocument()
  expect(screen.getByText("Applying repository access…")).toBeVisible()
})


it("settles all pending sandbox edits when the latest complete save fails, and retries that draft", async () => {
  const { actions, user } = renderApplication()
  vi.mocked(actions.saveGitHubConfiguration!)
    .mockImplementationOnce(() => new Promise<void>(() => {}))
    .mockRejectedValueOnce(new Error("Settings could not be saved"))
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  await user.click(github.getByRole("checkbox", { name: "All repositories for dev" }))
  await user.click(github.getByRole("checkbox", { name: "All repositories for playgrounds" }))
  expect(await github.findAllByRole("button", { name: /GitHub settings not applied/ })).toHaveLength(2)
  expect(screen.queryByText("Applying repository access…")).not.toBeInTheDocument()
  await user.click((await screen.findAllByRole("button", { name: "Retry" }))[0])
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledTimes(3)
  expect(actions.retryGitHubConfiguration).not.toHaveBeenCalled()
  expect(actions.saveGitHubConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
    workspaces: expect.arrayContaining([
      expect.objectContaining({ workspace: "dev", repositoryMode: "all" }),
      expect.objectContaining({ workspace: "playgrounds", repositoryMode: "all" }),
    ]),
  }))
})


it("applies repository changes immediately and commits identity fields on blur", async () => {
  const { actions, user } = renderApplication()
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))

  const name = github.getByLabelText("Git name for playgrounds")
  await user.clear(name)
  await user.type(name, "Morgan Example")
  expect(actions.saveGitHubConfiguration).not.toHaveBeenCalled()
  await user.tab()
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledOnce()
  expect(await screen.findByText("Applying Git identity…")).toBeVisible()
  expect(within(appNavigation()).getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-busy", "true")

  const picker = github.getByRole("combobox", { name: "Add repository to playgrounds" })
  await user.type(picker, "design")
  expect(screen.getByRole("option", { name: "acme/design-system" })).toBeVisible()
  expect(screen.queryByRole("option", { name: "acme/platform-tools" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("option", { name: "acme/design-system" }))
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledTimes(2)
  await user.click(picker)
  expect(screen.queryByRole("option", { name: "acme/design-system" })).not.toBeInTheDocument()

  const selected = github.getByRole("table", { name: "Selected repositories for playgrounds" })
  const pushes = within(selected).getByRole("checkbox", { name: "Allow GitHub changes for acme/platform-tools" })
  await user.click(pushes)
  expect(pushes).toBeChecked()
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledTimes(3)
  await user.click(within(selected).getByRole("button", { name: "Remove acme/design-system from playgrounds" }))
  expect(within(selected).queryByText("acme/design-system")).not.toBeInTheDocument()
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledTimes(4)
  expect(actions.saveGitHubConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
    workspaces: expect.arrayContaining([
      expect.objectContaining({
        workspace: "playgrounds",
        repositories: [{ repository: "acme/platform-tools", allowPushes: true }],
      }),
    ]),
  }))
  expect(github.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument()
  expect(github.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
})


it("keeps Git identity editable through disconnected and connecting GitHub states", async () => {
  const disconnectedSource = applicationSourceForScenario("running", "disconnected")
  disconnectedSource.github.accessEnabled = false
  const disconnected = renderApplication("running", disconnectedSource)
  await disconnected.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  let github = within(appPanel("GitHub"))
  expect(github.getByRole("heading", { name: "Not connected" })).toBeVisible()
  expect(github.getByLabelText("Git name for dev")).toBeEnabled()
  expect(github.queryByLabelText("Add repository to dev")).not.toBeInTheDocument()
  await disconnected.user.click(github.getByRole("button", { name: "Connect GitHub" }))
  expect(disconnected.actions.connectGitHub).toHaveBeenCalledOnce()
  expect(within(appNavigation()).getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-busy", "true")
  disconnected.unmount()

  const connecting = renderApplication("running", applicationSourceForScenario("running", "connecting"))
  await connecting.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  github = within(appPanel("GitHub"))
  expect(github.getByRole("status")).toHaveTextContent("Connecting to GitHub…")
  await connecting.user.click(github.getByRole("button", { name: "Open browser again" }))
  expect(connecting.actions.reopenGitHubAuthorization).toHaveBeenCalledOnce()
  await connecting.user.click(github.getByRole("button", { name: /^Cancel$/ }))
  expect(connecting.actions.cancelGitHubConnection).toHaveBeenCalledOnce()
  expect(github.getByLabelText("Git name for dev")).toBeEnabled()
  expect(github.queryByLabelText("Add repository to dev")).not.toBeInTheDocument()
})


it("disconnects the current GitHub account so another account can be connected", async () => {
  const { actions, user } = renderApplication()
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))

  await user.click(github.getByRole("button", { name: "Disconnect" }))
  expect(actions.disconnectGitHub).not.toHaveBeenCalled()
  expect(github.getByRole("button", { name: "Cancel" })).toBeVisible()
  expect(github.getByRole("button", { name: "Disconnect" })).toBeVisible()
  expect(github.queryByRole("heading", { name: "Not connected" })).not.toBeInTheDocument()
  await user.keyboard("{Escape}")
  expect(github.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  expect(actions.disconnectGitHub).not.toHaveBeenCalled()

  await user.click(github.getByRole("button", { name: "Disconnect" }))
  fireEvent.pointerDown(github.getByLabelText("Git name for dev"))
  expect(github.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  expect(actions.disconnectGitHub).not.toHaveBeenCalled()

  await user.click(github.getByRole("button", { name: "Disconnect" }))
  await user.click(github.getByRole("button", { name: "Cancel" }))
  expect(actions.disconnectGitHub).not.toHaveBeenCalled()
  expect(github.getByText("Connected as @taylor")).toBeVisible()
  await user.click(github.getByRole("button", { name: "Disconnect" }))
  await user.click(github.getByRole("button", { name: "Disconnect" }))
  expect(actions.disconnectGitHub).toHaveBeenCalledOnce()
  // A request alone must not claim that host access was revoked.
  expect(github.getByText("Connected as @taylor")).toBeVisible()
  expect(github.queryByRole("heading", { name: "Not connected" })).not.toBeInTheDocument()

})


it("applies access toggles immediately and confirms clearing one sandbox's repositories", async () => {
  const { actions, unmount, user } = renderApplication()
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))

  await user.click(github.getByRole("button", { name: "Clear repositories from dev" }))
  expect(screen.getByText("Remove all repositories from dev?")).toBeVisible()
  expect(screen.getByText("dev loses GitHub access to them.")).toBeVisible()
  expect(github.getByRole("table", { name: "Selected repositories for dev" })).toBeVisible()
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByText("Remove all repositories from dev?")).not.toBeInTheDocument())
  expect(github.getByRole("table", { name: "Selected repositories for dev" })).toBeVisible()
  await user.click(github.getByRole("button", { name: "Clear repositories from dev" }))
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(screen.queryByText("Remove all repositories from dev?")).not.toBeInTheDocument())
  expect(github.getByRole("table", { name: "Selected repositories for dev" })).toBeVisible()
  await user.click(github.getByRole("button", { name: "Clear repositories from dev" }))
  await user.click(screen.getByRole("button", { name: "Remove all" }))
  expect(github.queryByRole("table", { name: "Selected repositories for dev" })).not.toBeInTheDocument()
  expect(github.getByRole("table", { name: "Selected repositories for playgrounds" })).toBeVisible()
  expect(github.getByRole("table", { name: "Selected repositories for personal" })).toBeVisible()
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledOnce()
  expect(actions.saveGitHubConfiguration).toHaveBeenCalledWith(expect.objectContaining({
    workspaces: expect.arrayContaining([expect.objectContaining({ workspace: "dev", repositories: [] })]),
  }))
  unmount()

  const disabled = renderApplication(
    "running",
    applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "disabled"),
  )
  await disabled.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const disabledPanel = within(appPanel("GitHub"))
  expect(disabledPanel.getByRole("button", { name: "Enable access" })).toBeVisible()
  expect(disabledPanel.getByRole("table", { name: "Selected repositories for dev" })).toBeVisible()
  expect(disabledPanel.getByRole("button", { name: "Clear repositories from dev" })).toBeDisabled()
  await disabled.user.click(disabledPanel.getByRole("button", { name: "Enable access" }))
  expect(disabled.actions.setGitHubAccessEnabled).toHaveBeenCalledWith(true)
})


it("shows per-sandbox GitHub apply progress, success, and actionable failure through notifications", async () => {
  const source = applicationSourceForScenario("running", "connected")
  const application = renderApplication("running", source)
  await application.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  expect(github.queryByRole("button", { name: /not applied/i })).not.toBeInTheDocument()

  const next = (mode: "applying" | "succeeded" | "failed", revision: number) => {
    const fixture = applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, mode)
    fixture.github.policyRevision = revision
    application.rerender(<ApplicationPreview source={fixture} actions={application.actions} />)
  }

  // Only changes the user starts notify; background operations never do.
  await application.user.click(github.getByRole("button", { name: "Disable access" }))
  next("applying", 1)
  expect(await screen.findByText("Applying repository access…")).toBeVisible()
  expect(github.getByRole("region", { name: "Sandbox Git identity and repository access" })).toHaveAttribute("aria-busy", "true")

  next("succeeded", 2)
  expect(await screen.findByText("GitHub settings applied")).toBeVisible()
  expect(screen.queryByText("Applying repository access…")).not.toBeInTheDocument()

  await application.user.click(github.getByRole("button", { name: "Disable access" }))
  next("failed", 3)
  expect(await screen.findByText(/GitHub settings could not be applied\./)).toBeVisible()
  expect(screen.queryByText("GitHub settings applied")).not.toBeInTheDocument()
  expect(github.getByRole("button", { name: /GitHub settings not applied for dev/ })).toHaveTextContent("Not applied")
  await application.user.click(screen.getByRole("button", { name: "Retry" }))
  expect(application.actions.retryGitHubConfiguration).toHaveBeenCalledWith("dev")
})


it("keeps obsolete sandbox errors compact and copies only safe explanations", async () => {
  const source = applicationSourceForScenario("running", "connected")
  source.github.workspaceOperations = [{ workspace: "dev", status: "failed", canRetry: true,
    message: 'Recreate this development sandbox to enable the new GitHub integration. Git identity: {"before":"GIT_AUTHOR_EMAIL=private@example.com","disposition":"requires restart"}',
    diagnosticDetails: "secret runtime output",
  }]
  const application = renderApplication("running", source)
  await application.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const label = within(appPanel("GitHub")).getByRole("button", { name: /GitHub settings not applied for dev/ })
  expect(label).toHaveTextContent("Not applied")
  await application.user.click(label)
  const details = within(await screen.findByRole("dialog"))
  expect(details.getByText("This sandbox needs a new setup for GitHub access.")).toBeVisible()
  expect(details.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  expect(details.getByText(/A restart alone does not resolve/)).toBeVisible()
  expect(details.queryByText(/private@example|secret runtime|GIT_AUTHOR_EMAIL/)).not.toBeInTheDocument()
  const copy = vi.spyOn(navigator.clipboard, "writeText")
  await application.user.click(details.getByRole("button", { name: "Copy details" }))
  expect(copy).toHaveBeenCalledWith(expect.stringContaining("Git identity:"))
  expect(copy.mock.calls.at(-1)?.[0]).not.toMatch(/private@example|secret runtime|GIT_AUTHOR_EMAIL/)
})


it("keeps a successful GitHub apply notification until it is closed", async () => {
  vi.useFakeTimers()
  const application = renderApplication("running", applicationSourceForScenario("running", "connected"))

  try {
    fireEvent.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
    const succeeded = applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "succeeded")
    succeeded.github.policyRevision = 5
    fireEvent.click(screen.getByRole("button", { name: "Disable access" }))
    application.rerender(<ApplicationPreview source={succeeded} actions={application.actions} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(screen.getByText("GitHub settings applied")).toBeVisible()

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.getByText("GitHub settings applied")).toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: "Close toast" }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.queryByText("GitHub settings applied")).not.toBeInTheDocument()
  } finally {
    application.unmount()
    vi.useRealTimers()
  }
})


it("allows manual identity without host identity and explains unavailable repository catalog data", async () => {
  const source = applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "missing-host-identity")
  const { unmount, user } = renderApplication("running", source)
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))

  expect(github.getByRole("button", { name: "Reset Git identity for dev" })).toBeDisabled()
  expect(github.getByLabelText("Git name for dev")).toBeEnabled()
  expect(github.getByLabelText("Git name for dev")).toHaveValue("")
  unmount()

  const connectedEmpty = renderApplication(
    "running",
    applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "connected-empty"),
  )
  await connectedEmpty.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const emptyPanel = within(appPanel("GitHub"))
  expect(emptyPanel.queryByRole("table", { name: "Selected repositories for dev" })).not.toBeInTheDocument()
  expect(emptyPanel.getByRole("combobox", { name: "Add repository to dev" })).toBeVisible()
  connectedEmpty.unmount()

  const catalogUnavailable = renderApplication(
    "running",
    applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "catalog-unavailable"),
  )
  await catalogUnavailable.user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const unavailablePanel = within(appPanel("GitHub"))
  expect(unavailablePanel.getByRole("alert")).toHaveTextContent("GitHub repositories could not be loaded.")
  expect(unavailablePanel.queryByRole("combobox", { name: "Add repository to dev" })).not.toBeInTheDocument()
  await catalogUnavailable.user.click(unavailablePanel.getByRole("button", { name: "Retry repositories" }))
  expect(catalogUnavailable.actions.retryGitHubRepositoryCatalog).toHaveBeenCalledOnce()
})


it("keeps failed sign-in retry on Connect GitHub instead of repository refresh", async () => {
  const source = applicationSourceForScenario("running", "disconnected")
  source.github.repositoryCatalogStatus = { status: "unavailable", message: "GitHub connection is not configured in this build.", canRetry: false }
  const { user } = renderApplication("running", source)
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const github = within(appPanel("GitHub"))
  expect(github.getByRole("alert")).toHaveTextContent("GitHub connection is not configured in this build.")
  expect(github.getByRole("button", { name: "Connect GitHub" })).toBeEnabled()
  expect(github.queryByRole("button", { name: "Retry repositories" })).not.toBeInTheDocument()
})
