import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { OnboardingApp } from "@/features/onboarding/onboarding-app"
import type { GitHubConnectionState, OnboardingActions } from "@/features/onboarding/model/onboarding-source"
import { createMemorySettingsStore, SettingsProvider, type SettingsStore } from "@/features/preferences/settings-store"
import { onboardingScenarios, repositoryFixtures } from "@/fixtures/scenarios"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { fixtureApplicationCatalog } from "@/fixtures/application-catalog"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

function actions(): OnboardingActions {
  return { connectGitHub: vi.fn(), saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn() }
}

function onboarding(store: SettingsStore, handlers: OnboardingActions, { completed = false, githubConnectionState = "connected", scenario = "running", hostIdentity }: {
  completed?: boolean
  githubConnectionState?: GitHubConnectionState
  scenario?: "running" | "complete"
  hostIdentity?: { name: string; email: string } | null
} = {}) {
  return <SettingsProvider store={store}><ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(store)}><OnboardingApp
    source={{ ...onboardingScenarios[scenario], ...(hostIdentity !== undefined && { currentHostGitIdentity: hostIdentity }) }}
    actions={handlers}
    githubConnectionState={githubConnectionState}
    completed={completed}
    repositoryOptions={repositoryFixtures}
  /></SystemIntegrationProvider></ApplicationCatalogProvider></SettingsProvider>
}

async function restartStore(previous: SettingsStore) {
  await previous.flush()
  const saved = JSON.parse(JSON.stringify(previous.getSnapshot()))
  const next = createMemorySettingsStore(saved.settings)
  await next.updateOnboardingDraft(saved.onboardingDraft)
  return next
}

describe("onboarding restart recovery", () => {
  it("fills untouched identities when host detection finishes without replacing manual edits", async () => {
    const user = userEvent.setup()
    const store = createMemorySettingsStore()
    const handlers = actions()
    const view = render(onboarding(store, handlers, { hostIdentity: null }))
    await user.click(screen.getByRole("tab", { name: /GitHub/ }))
    expect(screen.getByLabelText("Git name for dev")).toHaveValue("")
    await user.type(screen.getByLabelText("Git name for playgrounds"), "My custom author")
    await user.click(screen.getByRole("checkbox", { name: "Apply Git identity to personal" }))
    const hostIdentity = { name: "Detected Author", email: "detected@example.test" }
    view.rerender(onboarding(store, handlers, { hostIdentity }))
    expect(screen.getByLabelText("Git name for dev")).toHaveValue(hostIdentity.name)
    expect(screen.getByLabelText("Git email for dev")).toHaveValue(hostIdentity.email)
    expect(screen.getByLabelText("Git name for playgrounds")).toHaveValue("My custom author")
    expect(screen.getByLabelText("Git email for playgrounds")).toHaveValue("")
    expect(screen.getByLabelText("Git name for personal")).toHaveValue("")
    await user.clear(screen.getByLabelText("Git name for dev"))
    await user.clear(screen.getByLabelText("Git email for dev"))
    view.rerender(onboarding(store, handlers, { hostIdentity: { ...hostIdentity } }))
    expect(screen.getByLabelText("Git name for dev")).toHaveValue("")
  })
  it("submits a restored sandbox draft once when Continue is clicked", async () => {
    const first = createMemorySettingsStore()
    const machine = { ...onboardingScenarios.complete.machineConfigurations[0], name: "recovered" }
    await first.updateOnboardingDraft({ currentStep: "workspaces", machines: [machine], unfinishedMachineEditor: null, workspaceSelections: { recovered: [] }, workspaceIdentities: { recovered: { name: "Saved Author", email: "saved@example.test", apply: true } } })
    const restored = await restartStore(first)
    const handlers = { ...actions(), submitStep: vi.fn() }
    render(onboarding(restored, handlers))
    expect(handlers.submitStep).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }))
    expect(handlers.submitStep).toHaveBeenCalledOnce()
    expect(handlers.submitStep).toHaveBeenCalledWith("workspaces", expect.objectContaining({ machineConfiguration: { schemaVersion: 1, machines: [machine] }, github: expect.objectContaining({ workspaces: [{ workspace: "recovered", repositories: [], identity: { name: "Saved Author", email: "saved@example.test", apply: true } }] }) }))
    expect(handlers.saveMachineConfiguration).not.toHaveBeenCalled()
    expect(screen.getByRole("tab", { name: /GitHub/ })).toHaveAttribute("aria-selected", "true")
  })

  it("applies saved reduced motion and follows shared changes without remounting the shell", async () => {
    const store = createMemorySettingsStore({ reduceMotion: true })
    render(onboarding(store, actions()))
    const shell = screen.getByRole("region", { name: "Silo Setup" })
    expect(shell).toHaveAttribute("data-reduce-motion", "true")
    await act(async () => { await store.updateSettings({ reduceMotion: false }) })
    expect(shell).not.toHaveAttribute("data-reduce-motion")
    await act(async () => { await store.updateSettings({ reduceMotion: true }) })
    expect(screen.getByRole("region", { name: "Silo Setup" })).toBe(shell)
    expect(shell).toHaveAttribute("data-reduce-motion", "true")
  })

  it("recovers incomplete SSH input and discards only the editor draft on Cancel", async () => {
    const user = userEvent.setup()
    const handlers = actions()
    const first = createMemorySettingsStore()
    const view = render(onboarding(first, handlers))
    await user.click(screen.getByRole("tab", { name: /Sandboxes/ }))
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(screen.getByRole("menuitem", { name: "Connect a machine via SSH" }))
    await user.clear(screen.getByRole("textbox", { name: "Machine name" }))
    await user.type(screen.getByRole("textbox", { name: "SSH host" }), "unfinished.")
    await user.clear(screen.getByRole("spinbutton", { name: "SSH port" }))
    view.unmount()

    const second = await restartStore(first)
    const restored = render(onboarding(second, handlers))
    expect(screen.getByRole("tab", { name: /Sandboxes/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("textbox", { name: "Machine name" })).toHaveValue("")
    expect(screen.getByRole("textbox", { name: "SSH host" })).toHaveValue("unfinished.")
    expect(screen.getByRole("textbox", { name: "SSH user" })).toHaveValue("")
    expect(screen.getByRole("spinbutton", { name: "SSH port" })).toHaveValue(0)
    expect(handlers.saveMachineConfiguration).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("Enter an SSH user.")).toBeVisible()
    expect(handlers.saveMachineConfiguration).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    restored.unmount()

    const third = await restartStore(second)
    render(onboarding(third, handlers))
    expect(screen.queryByRole("textbox", { name: "Machine name" })).not.toBeInTheDocument()
    expect(within(screen.getByRole("list", { name: "Configured sandboxes" })).getAllByRole("listitem")).toHaveLength(3)
    expect(third.getSnapshot().onboardingDraft?.unfinishedMachineEditor).toBeNull()
  })

  it("restores machine edits, ordering, repository access, identity choices, and the active step without applying them", async () => {
    const user = userEvent.setup()
    const handlers = actions()
    const first = createMemorySettingsStore()
    const view = render(onboarding(first, handlers))
    await user.click(screen.getByRole("tab", { name: /GitHub/ }))
    await user.clear(screen.getByLabelText("Git name for dev"))
    await user.type(screen.getByLabelText("Git name for dev"), "Recovered Author")
    await user.clear(screen.getByLabelText("Git email for dev"))
    await user.type(screen.getByLabelText("Git email for dev"), "unfinished@")
    await user.click(screen.getByRole("checkbox", { name: "Apply Git identity to dev" }))
    const pushes = within(screen.getByRole("table", { name: "Selected repositories for dev" })).getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" })
    if (pushes.getAttribute("aria-checked") === "false") await user.click(pushes)

    await user.click(screen.getByRole("tab", { name: /Sandboxes/ }))
    await user.click(screen.getByRole("button", { name: "Edit dev" }))
    await user.clear(screen.getByRole("textbox", { name: "Machine name" }))
    await user.type(screen.getByRole("textbox", { name: "Machine name" }), "development")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await user.click(screen.getByRole("button", { name: "Reorder personal" }))
    await user.keyboard("{ArrowUp}{ArrowUp}")
    await user.click(screen.getByRole("tab", { name: /Review/ }))
    view.unmount()

    const second = await restartStore(first)
    vi.mocked(handlers.saveMachineConfiguration).mockClear()
    const restored = render(onboarding(second, handlers, { githubConnectionState: "disconnected" }))
    expect(screen.getByRole("tab", { name: /Review/ })).toHaveAttribute("aria-selected", "true")
    const list = screen.getByRole("list", { name: "Sandboxes" })
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("personal"), expect.stringContaining("development"), expect.stringContaining("playgrounds"),
    ])
    expect(screen.getByText("GitHub not connected")).toBeVisible()
    expect(handlers.connectGitHub).not.toHaveBeenCalled()
    expect(handlers.saveMachineConfiguration).not.toHaveBeenCalled()
    expect(handlers.finishSetup).not.toHaveBeenCalled()
    await user.click(screen.getByRole("tab", { name: /GitHub/ }))
    expect(screen.getByLabelText("Git name for development")).toHaveValue("Recovered Author")
    expect(screen.getByLabelText("Git email for development")).toHaveValue("unfinished@")
    expect(screen.getByRole("checkbox", { name: "Apply Git identity to development" })).not.toBeChecked()
    restored.rerender(onboarding(second, handlers))
    expect(within(screen.getByRole("table", { name: "Selected repositories for development" })).getByRole("checkbox", { name: "Allow GitHub changes for acme/silo" })).toBeChecked()
    expect(second.getSnapshot().onboardingDraft?.unfinishedMachineEditor).toBeNull()
  })

  it("saves shared application choices immediately and clears recovery only after confirmed completion", async () => {
    const user = userEvent.setup()
    const handlers = actions()
    const store = createMemorySettingsStore({ terminal: "iTerm", editor: "Cursor", browser: "Firefox" })
    const view = render(onboarding(store, handlers, { scenario: "complete" }))
    expect(screen.getByRole("combobox", { name: "Terminal" })).toHaveTextContent("iTerm")
    expect(screen.getByRole("combobox", { name: "Code editor" })).toHaveTextContent("Cursor")
    await user.click(screen.getByRole("combobox", { name: "Browser" }))
    await user.click(screen.getByRole("option", { name: "Google Chrome" }))
    expect(store.getSnapshot().settings.browser).toBe("Google Chrome")
    await act(async () => { await store.updateSettings({ editor: "Zed" }) })
    expect(screen.getByRole("combobox", { name: "Code editor" })).toHaveTextContent("Zed")
    await user.click(screen.getByRole("tab", { name: /Review/ }))
    await user.click(screen.getByRole("button", { name: "Finish" }))
    expect(handlers.finishSetup).toHaveBeenCalledOnce()
    expect(handlers.finishSetup).toHaveBeenCalledWith(expect.objectContaining({ applications: { terminal: "iTerm", editor: "Zed", browser: "Google Chrome", browserPath: "/fixture/Google Chrome.app", terminalUseSystemDefault: false, editorUseSystemDefault: false, browserUseSystemDefault: false } }))
    expect(store.getSnapshot().onboardingDraft?.currentStep).toBe("review")
    expect(store.getSnapshot().onboardingDraft).not.toHaveProperty("applications")
    view.rerender(onboarding(store, handlers, { completed: true, scenario: "complete" }))
    await act(async () => { await store.flush() })
    expect(store.getSnapshot().onboardingDraft).toBeNull()
    expect(store.getSnapshot().settings).toMatchObject({ terminal: "iTerm", editor: "Zed", browser: "Google Chrome", browserPath: "/fixture/Google Chrome.app" })
  })
})
