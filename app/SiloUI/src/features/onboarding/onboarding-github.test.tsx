import { setupFakeTimerUser } from "@/test/fake-timer-user"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { OnboardingPreview } from "@/fixtures/onboarding-preview"

import type { GitHubConnectionState } from "@/features/onboarding/model/onboarding-source"

import { onboardingScenarios, repositoryFixtures } from "@/fixtures/scenarios"

function renderScenario(name: keyof typeof onboardingScenarios = "running", githubState?: GitHubConnectionState) {
  return render(<OnboardingPreview source={onboardingScenarios[name]} initialGitHubConnectionState={githubState} repositoryOptions={repositoryFixtures} actions={{
    saveMachineConfiguration: vi.fn(),
    retryWorkspaceSetup: vi.fn(),
    finishSetup: vi.fn(),
  }} />)
}

function expectHiddenPanelHeading(name: string) {
  const heading = screen.getByRole("heading", { name, level: 2 })
  expect(heading).toHaveAttribute("data-visual-heading", "hidden")
  expect(heading.parentElement?.tagName).toBe("SECTION")
}

it("uses singular sandbox labels in the review of one sandbox", async () => {
  const user = userEvent.setup()
  const source = { ...onboardingScenarios.complete, machineConfigurations: [onboardingScenarios.complete.machineConfigurations[0]], githubPolicies: [] }
  render(<OnboardingPreview source={source} initialGitHubConnectionState="connected" />)
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  expect(screen.getByText(/^Taylor Example/).textContent).toBe("Taylor Example <taylor@example.com> → all 1 sandbox")
  expect(screen.getByText(/^0 repositories across/).textContent).toBe("0 repositories across 0 of 1 sandbox · 0 repositories allowing GitHub changes")
})


it("continues from disconnected GitHub without marking it complete", async () => {
  const user = userEvent.setup()
  renderScenario("running", "disconnected")

  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  const githubFooter = screen.getByLabelText("Onboarding actions")
  const githubTab = screen.getByRole("tab", { name: /GitHub/ })
  expect(within(githubFooter).getAllByRole("button").map(({ textContent }) => textContent)).toEqual(["Back", "Continue"])
  expect(within(githubFooter).getByRole("button", { name: "Continue" })).toBeEnabled()
  expect(within(githubFooter).queryByRole("button", { name: /skip/i })).not.toBeInTheDocument()
  expect(githubTab).toHaveAccessibleDescription("Waiting")
  expect(githubTab).not.toHaveAttribute("aria-busy", "true")

  await user.click(within(githubFooter).getByRole("button", { name: "Continue" }))
  expectHiddenPanelHeading("Review setup")
  expect(screen.getByText("GitHub not connected")).toBeVisible()
  expect(screen.getByText("Taylor Example <taylor@example.com> → all 3 sandboxes")).toBeVisible()
})


it("finishes without submitting saved repository selections when GitHub is skipped", async () => {
  const user = userEvent.setup()
  const finishSetup = vi.fn()
  render(<OnboardingPreview source={onboardingScenarios.complete} initialGitHubConnectionState="disconnected" actions={{ finishSetup }} />)
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  expect(screen.getByText("GitHub not connected")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Finish" }))
  expect(finishSetup).toHaveBeenCalledOnce()
  const request = finishSetup.mock.calls[0][0]
  expect(request.github.connectionState).toBe("disconnected")
  expect(request.github.workspaces.every(({ repositories }: { repositories: unknown[] }) => repositories.length === 0)).toBe(true)
  expect(request.github.workspaces[0].identity).toMatchObject({ name: "Taylor Example", email: "taylor@example.com", apply: true })
})


it("continues while GitHub is connecting and marks it in progress", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connecting")

  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  const githubTab = screen.getByRole("tab", { name: /GitHub/ })
  expect(githubTab).toHaveAccessibleDescription("In progress")
  expect(githubTab).toHaveAttribute("aria-busy", "true")
  const continueButton = screen.getByRole("button", { name: "Continue" })
  expect(continueButton).toBeEnabled()

  await user.click(continueButton)
  expectHiddenPanelHeading("Review setup")
})


it("continues with zero repository access and keeps connected GitHub complete", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connected")

  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  const githubTab = screen.getByRole("tab", { name: /GitHub/ })
  expect(githubTab).toHaveAccessibleDescription("Complete")
  expect(githubTab).not.toHaveAttribute("aria-busy", "true")

  await user.click(screen.getByRole("button", { name: "Remove acme/silo from dev" }))
  expect(githubTab).toHaveAccessibleDescription("Complete")
  const continueButton = screen.getByRole("button", { name: "Continue" })
  expect(continueButton).toBeEnabled()
  await user.click(continueButton)

  expectHiddenPanelHeading("Review setup")
  expect(screen.getByText("0 repositories across 0 of 3 sandboxes · 0 repositories allowing GitHub changes")).toBeVisible()
})


it("renders stable disconnected, connecting, and connected GitHub states", async () => {
  vi.useFakeTimers()
  const user = setupFakeTimerUser()
  const disconnected = renderScenario("running", "disconnected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  expect(screen.getByRole("heading", { name: "Not connected" })).toBeVisible()
  expect(screen.getByLabelText("Git name for dev")).toHaveValue("Taylor Example")
  expect(screen.getByLabelText("Git email for dev")).toHaveValue("taylor@example.com")
  expect(screen.queryByLabelText("Add repository to dev")).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Connect GitHub" }))
  expect(screen.getByRole("heading", { name: "Connecting to GitHub…" })).toBeVisible()
  expect(screen.getByLabelText("Git name for dev")).toBeEnabled()
  expect(screen.queryByLabelText("Add repository to dev")).not.toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(699) })
  expect(screen.getByRole("heading", { name: "Connecting to GitHub…" })).toBeVisible()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.getByRole("heading", { name: "Connected to GitHub" })).toBeVisible()
  expect(screen.getByLabelText("Add repository to dev")).toBeVisible()
  disconnected.unmount()

  const connecting = renderScenario("running", "connecting")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("heading", { name: "Connecting to GitHub…" })).toBeVisible()
  connecting.unmount()

  renderScenario("running", "connected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("heading", { name: "Connected to GitHub" })).toBeVisible()
})


it("derives the default GitHub state and repository catalog from the native source", async () => {
  const user = userEvent.setup()
  const devPolicy = onboardingScenarios.running.githubPolicies[0]
  const source = {
    ...onboardingScenarios.running,
    githubPolicies: [{
      ...devPolicy,
      repositories: [
        devPolicy.repositories[0],
        {
          ...devPolicy.repositories[0],
          repositoryID: 1002,
          fullName: "acme/design-system",
          mode: "read-write" as const,
        },
      ],
    }],
  }
  render(<OnboardingPreview source={source} actions={{
    saveMachineConfiguration: vi.fn(),
    retryWorkspaceSetup: vi.fn(),
    finishSetup: vi.fn(),
  }} />)

  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("heading", { name: "Connected to GitHub" })).toBeVisible()
  const selected = screen.getByRole("table", { name: "Selected repositories for dev" })
  expect(within(selected).getByText("acme/silo")).toBeVisible()
  expect(within(selected).getByText("acme/design-system")).toBeVisible()
  expect(within(selected).getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" })).not.toBeChecked()
  expect(within(selected).getByRole("checkbox", { name: "Allow GitHub changes for acme/design-system" })).toBeChecked()

  await user.click(screen.getByLabelText("Add repository to playgrounds"))
  expect(screen.getAllByRole("option").map(({ textContent }) => textContent)).toEqual(["acme/silo", "acme/design-system"])
})


it("searches, adds multiple repositories, prevents duplicates, and retains push choices", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  expect(screen.getByRole("region", { name: "Sandbox Git identity and repository access" })).toBeVisible()
  expect(screen.queryByRole("heading", { name: "Sandbox Git identity and repository access" })).not.toBeInTheDocument()
  expect(screen.queryByText("Selected repositories always allow local writes and commits.")).not.toBeInTheDocument()
  for (const workspace of ["dev", "playgrounds", "personal"]) {
    expect(screen.getByLabelText(`Add repository to ${workspace}`)).toHaveAttribute("role", "combobox")
  }
  expect(screen.queryByText(/read only|read-write/i)).not.toBeInTheDocument()

  const picker = screen.getByLabelText("Add repository to playgrounds")
  await user.type(picker, "design")
  expect(screen.getByRole("option", { name: "acme/design-system" })).toBeVisible()
  expect(screen.queryByRole("option", { name: "acme/platform-tools" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("option", { name: "acme/design-system" }))

  await user.click(picker)
  expect(screen.queryByRole("option", { name: "acme/design-system" })).not.toBeInTheDocument()
  await user.type(picker, "platform")
  await user.keyboard("{Enter}")

  const selected = screen.getByRole("table", { name: "Selected repositories for playgrounds" })
  expect(within(selected).getByText("acme/design-system")).toBeVisible()
  expect(within(selected).getByText("acme/platform-tools")).toBeVisible()
  const pushes = within(selected).getByRole("checkbox", { name: "Allow GitHub changes for acme/platform-tools" })
  expect(pushes).not.toBeChecked()
  await user.click(pushes)
  expect(pushes).toBeChecked()

  const name = screen.getByLabelText("Git name for playgrounds")
  await user.clear(name)
  await user.type(name, "Morgan Example")
  const retained = screen.getByRole("table", { name: "Selected repositories for playgrounds" })
  expect(within(retained).getByText("acme/design-system")).toBeVisible()
  expect(within(retained).getByText("acme/platform-tools")).toBeVisible()
  expect(within(retained).getByRole("checkbox", { name: "Allow GitHub changes for acme/platform-tools" })).toBeChecked()

  await user.click(screen.getByRole("tab", { name: /Review/ }))
  expect(screen.getByText("3 repositories across 2 of 3 sandboxes · 1 repository allowing GitHub changes")).toBeVisible()
  expect(screen.getByText("Taylor Example <taylor@example.com> → dev, personal; Morgan Example <taylor@example.com> → playgrounds")).toBeVisible()
})


it("collapses GitHub sandbox sections independently", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  const devDisclosure = screen.getByRole("button", { name: "Collapse dev" })
  await user.click(devDisclosure)
  expect(devDisclosure).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByRole("group", { name: "Git identity for dev" })).not.toBeInTheDocument()
  expect(screen.getByRole("group", { name: "Git identity for playgrounds" })).toBeVisible()
})


it("treats repository names as case-insensitive when preventing duplicates", async () => {
  const user = userEvent.setup()
  render(<OnboardingPreview
    source={onboardingScenarios.running}
    initialGitHubConnectionState="connected"
    repositoryOptions={["ACME/SILO", "acme/silo", "acme/design-system"]}
    actions={{ saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn() }}
  />)
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  const picker = screen.getByLabelText("Add repository to playgrounds")
  await user.click(picker)
  expect(screen.getAllByRole("option").map(({ textContent }) => textContent)).toEqual(["ACME/SILO", "acme/design-system"])

  await user.click(screen.getByRole("option", { name: "ACME/SILO" }))
  await user.click(picker)

  expect(screen.getAllByRole("option").map(({ textContent }) => textContent)).toEqual(["acme/design-system"])
  expect(within(screen.getByRole("table", { name: "Selected repositories for playgrounds" })).getAllByRole("row")).toHaveLength(2)
})


it("removes repositories and keeps the review summary truthful", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  await user.click(screen.getByRole("button", { name: "Remove acme/silo from dev" }))
  expect(screen.queryByRole("table", { name: "Selected repositories for dev" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("tab", { name: /Review/ }))

  expect(screen.getByText("0 repositories across 0 of 3 sandboxes · 0 repositories allowing GitHub changes")).toBeVisible()
})


it("exposes the Allow GitHub changes explanation to keyboard users", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  const tooltipTrigger = screen.getByRole("button", { name: "About Allow GitHub changes" })
  screen.getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" }).focus()
  await user.tab({ shift: true })
  expect(screen.getByRole("button", { name: "Clear repositories from dev" })).toHaveFocus()
  await user.tab({ shift: true })

  expect(tooltipTrigger).toHaveFocus()
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Allow Git pushes and GitHub changes, such as issues and pull requests, from this sandbox.")
})


it("prefills and enables every workspace identity from the optional host identity", async () => {
  const user = userEvent.setup()
  renderScenario("running", "disconnected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  expect(screen.getAllByRole("checkbox", { name: /^Apply Git identity to / })).toHaveLength(3)
  for (const checkbox of screen.getAllByRole("checkbox", { name: /^Apply Git identity to / })) {
    expect(checkbox).toBeChecked()
  }
  const identityRows = screen.getAllByRole("group", { name: /^Git identity for / })
  expect(identityRows).toHaveLength(3)
  for (const row of identityRows) expect(row).toHaveAttribute("data-layout", "compact-row")
  const devIdentity = screen.getByRole("group", { name: "Git identity for dev" })
  expect(within(devIdentity).getByPlaceholderText("Name")).toHaveAccessibleName("Git name for dev")
  expect(within(devIdentity).getByPlaceholderText("Email")).toHaveAccessibleName("Git email for dev")
  expect(within(devIdentity).getByRole("checkbox")).toHaveAccessibleName("Apply Git identity to dev")
  expect(within(devIdentity).getByRole("button")).toHaveAccessibleName("Reset Git identity for dev")
  const identityTooltipTrigger = within(devIdentity).getByLabelText("About Git identity for dev")
  act(() => identityTooltipTrigger.focus())
  expect(identityTooltipTrigger).toHaveFocus()
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Name and email used for Git commits in this sandbox.")
  expect(screen.queryByText("Git name")).not.toBeInTheDocument()
  expect(screen.queryByText("Git email")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Git name for personal")).toHaveValue("Taylor Example")
  expect(screen.getByLabelText("Git email for personal")).toHaveValue("taylor@example.com")
  expect(screen.getByRole("button", { name: "Reset Git identity for personal" })).toBeEnabled()
})


it("uses one custom tooltip for each Git identity Reset control", async () => {
  const user = userEvent.setup()
  renderScenario("running", "disconnected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  for (const workspace of ["dev", "playgrounds", "personal"]) {
    const name = `Reset Git identity for ${workspace}`
    const reset = screen.getByRole("button", { name })
    const trigger = reset.parentElement
    expect(trigger).not.toBeNull()
    expect(reset).toHaveAccessibleName(name)
    expect(reset).not.toHaveAttribute("title")
    expect(trigger).not.toHaveAttribute("title")

    fireEvent.focus(reset)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(name)
    expect(screen.getAllByRole("tooltip")).toHaveLength(1)
    fireEvent.blur(reset)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument())

    await user.hover(reset)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(name)
    expect(screen.getAllByRole("tooltip")).toHaveLength(1)
    await user.unhover(reset)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument())
  }
})


it("keeps workspace identity edits and apply choices independent and resets one workspace", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  const playgroundsName = screen.getByLabelText("Git name for playgrounds")
  const playgroundsEmail = screen.getByLabelText("Git email for playgrounds")
  await user.clear(playgroundsName)
  await user.type(playgroundsName, "Morgan Example")
  await user.clear(playgroundsEmail)
  await user.type(playgroundsEmail, "morgan@example.com")
  await user.click(screen.getByRole("checkbox", { name: "Apply Git identity to personal" }))

  expect(screen.getByLabelText("Git name for dev")).toHaveValue("Taylor Example")
  expect(screen.getByRole("checkbox", { name: "Apply Git identity to dev" })).toBeChecked()
  expect(screen.getByRole("checkbox", { name: "Apply Git identity to personal" })).not.toBeChecked()

  await user.click(screen.getByRole("button", { name: "Reset Git identity for playgrounds" }))
  expect(playgroundsName).toHaveValue("Taylor Example")
  expect(playgroundsEmail).toHaveValue("taylor@example.com")
  expect(screen.getByRole("checkbox", { name: "Apply Git identity to personal" })).not.toBeChecked()

  await user.clear(playgroundsName)
  await user.type(playgroundsName, "Morgan Example")
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  expect(screen.getByText("Taylor Example <taylor@example.com> → dev; Morgan Example <taylor@example.com> → playgrounds; not applied → personal")).toBeVisible()
})


it("starts blank and leaves Reset safely unavailable without a host identity", async () => {
  const user = userEvent.setup()
  render(<OnboardingPreview
    source={{ ...onboardingScenarios.running, currentDeviceGitIdentity: null }}
    initialGitHubConnectionState="disconnected"
    actions={{ saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn() }}
  />)
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))

  const name = screen.getByLabelText("Git name for dev")
  const email = screen.getByLabelText("Git email for dev")
  const reset = screen.getByRole("button", { name: "Reset Git identity for dev" })
  expect(name).toHaveValue("")
  expect(email).toHaveValue("")
  expect(reset).toBeDisabled()
  expect(reset).toHaveAccessibleName("Reset Git identity for dev")
  expect(reset).not.toHaveAttribute("title")

  const resetTooltipTrigger = reset.parentElement
  expect(resetTooltipTrigger).not.toBeNull()
  expect(resetTooltipTrigger).toHaveAccessibleName("Reset Git identity for dev")
  expect(resetTooltipTrigger).not.toHaveAttribute("title")
  fireEvent.focus(resetTooltipTrigger!)
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Reset Git identity for dev")
  expect(screen.getAllByRole("tooltip")).toHaveLength(1)
  fireEvent.blur(resetTooltipTrigger!)
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument())

  await user.hover(resetTooltipTrigger!)
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Reset Git identity for dev")
  expect(screen.getAllByRole("tooltip")).toHaveLength(1)
  await user.unhover(resetTooltipTrigger!)
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument())

  await user.type(name, "Local User")
  await user.click(reset)
  expect(name).toHaveValue("Local User")
})
