import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import type { ApplicationGitHubWorkspacePolicy } from "@/features/application/model/application-source"
import type { OnboardingDraft } from "@/features/onboarding/model/onboarding-draft"
import type { OnboardingSource } from "@/features/onboarding/model/onboarding-source"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { onboardingScenarios } from "@/fixtures/scenarios"
import { OnboardingApp } from "./onboarding-app"

const source: OnboardingSource = { ...onboardingScenarios.complete, githubPolicies: [], machinesAuthoritative: true }
const policies: ApplicationGitHubWorkspacePolicy[] = [{
  workspace: "dev",
  repositoryMode: "selected",
  allRepositoriesAllowChanges: false,
  repositories: [{ repository: "acme/silo", allowPushes: true }],
  identity: { name: "Saved Author", email: "saved@example.test", apply: false },
}, {
  workspace: "playgrounds",
  repositoryMode: "all",
  allRepositoriesAllowChanges: true,
  repositories: [{ repository: "acme/tools", allowPushes: false }],
  identity: { name: "Other Author", email: "other@example.test", apply: true },
}]

function setup(initialSource = source, initialPolicies?: ApplicationGitHubWorkspacePolicy[], restored: OnboardingDraft | null = null, tokenConnected = false) {
  const store = createMemorySettingsStore({}, restored)
  const actions = { connectGitHub: vi.fn(), saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn(), submitStep: vi.fn() }
  const wrap = (currentSource: OnboardingSource, repositoryPolicies?: ApplicationGitHubWorkspacePolicy[]) => (
    <SettingsProvider store={store}><OnboardingApp source={currentSource} actions={actions} repositoryPolicies={repositoryPolicies}
      tokenConnected={tokenConnected} repositoryOptions={["acme/silo", "acme/tools"]} githubConnectionState="connected" completed={false} /></SettingsProvider>
  )
  return { ...render(wrap(initialSource, initialPolicies)), wrap, store, actions, user: userEvent.setup() }
}

it.each([false, true])("handles a sandbox named constructor with missing policies (recovered=%s)", async (recovered) => {
  const machine = { ...source.machineConfigurations[0], name: "constructor" }
  const current = { ...source, machineConfigurations: [machine], progressEvents: [], bootstrapConfiguration: {
    ...source.bootstrapConfiguration,
    workspaces: [{ ...source.bootstrapConfiguration.workspaces[0], name: machine.name }],
  } }
  const restored: OnboardingDraft | null = recovered ? {
    currentStep: "github", machines: [machine], unfinishedMachineEditor: null,
    workspaceSelections: {}, workspaceIdentities: {},
  } : null
  const view = setup(current, [], restored)

  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  await view.user.click(screen.getByRole("button", { name: "Continue" }))

  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: [expect.objectContaining({ workspace: "constructor", repositories: [] })] }),
  }))
})

it("shows a missing recovered Git identity as unapplied, matching the submission", async () => {
  const restored: OnboardingDraft = {
    currentStep: "github", machines: source.machineConfigurations, unfinishedMachineEditor: null,
    workspaceSelections: {}, workspaceIdentities: {},
  }
  const view = setup({ ...source, currentHostGitIdentity: null }, [], restored)

  expect(screen.getByRole("checkbox", { name: "Apply Git identity to dev" })).not.toBeChecked()
  await view.user.click(screen.getByRole("button", { name: "Continue" }))

  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([
      expect.objectContaining({ workspace: "dev", identity: { name: "", email: "", apply: false } }),
    ]) }),
  }))
})

it("skips applying a blank host identity and adopts an identity that loads later", async () => {
  const view = setup({ ...source, currentHostGitIdentity: null }, [])
  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("checkbox", { name: "Apply Git identity to dev" })).not.toBeChecked()
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([
      expect.objectContaining({ workspace: "dev", identity: { name: "", email: "", apply: false } }),
    ]) }),
  }))

  await act(async () => { view.rerender(view.wrap(source, [])) })
  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("checkbox", { name: "Apply Git identity to dev" })).toBeChecked()
  expect(screen.getByLabelText("Git name for dev")).toHaveValue(source.currentHostGitIdentity!.name)
})

it("finishes with current application preferences after keeping omitted sandboxes", async () => {
  const restored: OnboardingDraft = {
    currentStep: "review", machines: [source.machineConfigurations[0]], unfinishedMachineEditor: null,
    workspaceSelections: {}, workspaceIdentities: {},
  }
  const view = setup({ ...source, existingMachines: source.machineConfigurations }, [], restored)
  await view.user.click(screen.getByRole("button", { name: "Finish" }))
  expect(view.actions.finishSetup).not.toHaveBeenCalled()

  await act(async () => { await view.store.updateSettings({ browser: "Firefox", browserPath: "/Applications/Firefox.app", browserUseSystemDefault: false }) })
  await view.user.click(screen.getByRole("button", { name: "Keep sandboxes" }))

  expect(view.actions.finishSetup).toHaveBeenCalledWith(expect.objectContaining({
    applications: expect.objectContaining({ browser: "Firefox", browserPath: "/Applications/Firefox.app", browserUseSystemDefault: false }),
  }))
})

it("keeps saved GitHub policies when restoring an omitted sandbox before Finish", async () => {
  const restored: OnboardingDraft = {
    currentStep: "review", machines: [source.machineConfigurations[0]], unfinishedMachineEditor: null,
    workspaceSelections: {}, workspaceIdentities: {},
  }
  const savedPolicies = [policies[0], { ...policies[1], authenticationMethod: "token" as const }]
  const view = setup({ ...source, existingMachines: source.machineConfigurations }, savedPolicies, restored, true)
  await view.user.click(screen.getByRole("button", { name: "Finish" }))
  await view.user.click(screen.getByRole("button", { name: "Keep sandboxes" }))

  expect(view.actions.finishSetup).toHaveBeenCalledWith(expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining(savedPolicies) }),
  }))
})

it.each(["before render", "after equal machines", "after changed machines"])("submits untouched saved policies loaded %s", async (timing) => {
  const initial = timing === "after changed machines"
    ? { ...source, machinesAuthoritative: false, machineConfigurations: [source.machineConfigurations[0]] }
    : { ...source, machinesAuthoritative: timing === "before render" }
  const view = setup(initial, timing === "before render" ? policies : [])
  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  if (timing !== "before render") await act(async () => { view.rerender(view.wrap(source, policies)) })
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining(policies) }),
  }))
  expect(view.store.getSnapshot().onboardingDraft?.workspaceSelections.dev).toEqual(policies[0].repositories)
})

it("loads untouched policy fields without replacing explicit edits made during loading", async () => {
  const view = setup(source, [])
  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  await view.user.click(screen.getByRole("checkbox", { name: "All repositories for dev" }))
  const author = screen.getByLabelText("Git name for dev")
  await view.user.clear(author)
  await view.user.type(author, "My Author")
  await view.user.click(screen.getByRole("combobox", { name: "Add repository to playgrounds" }))
  await view.user.click(screen.getByRole("option", { name: "acme/silo" }))
  await act(async () => { view.rerender(view.wrap(source, policies)) })
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([
      { ...policies[0], repositoryMode: "all", identity: { ...onboardingScenarios.complete.currentHostGitIdentity, name: "My Author", apply: true } },
      { ...policies[1], repositories: [{ repository: "acme/silo", allowPushes: false }] },
    ]) }),
  }))
})

it("keeps restored policy fields including deliberately empty selections when saved policies arrive", async () => {
  const restored: OnboardingDraft = {
    currentStep: "github", machines: source.machineConfigurations, unfinishedMachineEditor: null,
    workspaceSelections: { dev: [] },
    workspaceRepositoryAccess: { dev: { repositoryMode: "all", allRepositoriesAllowChanges: true } },
    workspaceIdentities: { dev: { name: "Recovered Author", email: "recovered@example.test", apply: true } },
  }
  const view = setup(source, [], restored)
  await act(async () => { view.rerender(view.wrap(source, policies)) })
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([
      { workspace: "dev", ...restored.workspaceRepositoryAccess!.dev, repositories: [], identity: restored.workspaceIdentities.dev },
      policies[1],
    ]) }),
  }))
})


it.each(["before render", "after render"])("preserves token authentication loaded %s through Continue, recovery, and Finish", async (timing) => {
  const tokenPolicy: ApplicationGitHubWorkspacePolicy = { ...policies[0], authenticationMethod: "token" }
  const view = setup(source, timing === "before render" ? [tokenPolicy] : [], null, true)
  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  if (timing === "after render") await act(async () => { view.rerender(view.wrap(source, [tokenPolicy])) })
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeEnabled()
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([tokenPolicy]) }),
  }))
  await act(async () => { await view.store.flush() })
  const saved = structuredClone(view.store.getSnapshot().onboardingDraft)
  expect(saved?.workspaceRepositoryAccess?.dev).toEqual({
    authenticationMethod: "token", repositoryMode: "selected", allRepositoriesAllowChanges: false,
  })
  view.unmount()

  const resumed = setup(source, [{ ...tokenPolicy, authenticationMethod: "oauth" }], saved, true)
  await resumed.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
  await resumed.user.click(screen.getByRole("tab", { name: /Review/ }))
  await resumed.user.click(screen.getByRole("button", { name: "Finish" }))
  expect(resumed.actions.finishSetup).toHaveBeenCalledWith(expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([tokenPolicy]) }),
  }))
})

it("submits and recovers a deliberate switch from token to OAuth", async () => {
  const view = setup(source, [{ ...policies[0], authenticationMethod: "token" }], null, true)
  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
  await view.user.click(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" }))
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([{ ...policies[0], authenticationMethod: "oauth" }]) }),
  }))
  await act(async () => { await view.store.flush() })
  const saved = structuredClone(view.store.getSnapshot().onboardingDraft)
  view.unmount()
  const resumed = setup(source, [{ ...policies[0], authenticationMethod: "token" }], saved, true)
  await resumed.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByRole("radio", { name: "Use GitHub OAuth for dev" })).toBeChecked()
})


it("fills a missing authentication method in older recovered drafts without changing their repository choices", async () => {
  const restored: OnboardingDraft = {
    currentStep: "github", machines: source.machineConfigurations, unfinishedMachineEditor: null,
    workspaceSelections: { dev: [] }, workspaceIdentities: { dev: policies[0].identity },
    workspaceRepositoryAccess: { dev: { repositoryMode: "all", allRepositoriesAllowChanges: true } },
  }
  const view = setup(source, [{ ...policies[0], authenticationMethod: "token" }], restored, true)
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([{
      ...policies[0], authenticationMethod: "token", repositoryMode: "all", allRepositoriesAllowChanges: true, repositories: [],
    }]) }),
  }))
})

it("keeps repository edits while initializing the untouched authentication method from a late policy", async () => {
  const view = setup(source, [], null, true)
  await view.user.click(screen.getByRole("tab", { name: /GitHub/ }))
  await view.user.click(screen.getByRole("checkbox", { name: "All repositories for dev" }))
  await act(async () => { view.rerender(view.wrap(source, [{ ...policies[0], authenticationMethod: "token" }])) })
  await view.user.click(screen.getByRole("button", { name: "Continue" }))
  expect(view.actions.submitStep).toHaveBeenCalledWith("github", expect.objectContaining({
    github: expect.objectContaining({ workspaces: expect.arrayContaining([{
      ...policies[0], authenticationMethod: "token", repositoryMode: "all",
    }]) }),
  }))
})
