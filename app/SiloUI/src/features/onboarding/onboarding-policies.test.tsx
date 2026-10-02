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

function setup(initialSource = source, initialPolicies?: ApplicationGitHubWorkspacePolicy[], restored: OnboardingDraft | null = null) {
  const store = createMemorySettingsStore({}, restored)
  const actions = { connectGitHub: vi.fn(), saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn(), submitStep: vi.fn() }
  const wrap = (currentSource: OnboardingSource, repositoryPolicies?: ApplicationGitHubWorkspacePolicy[]) => (
    <SettingsProvider store={store}><OnboardingApp source={currentSource} actions={actions} repositoryPolicies={repositoryPolicies}
      repositoryOptions={["acme/silo", "acme/tools"]} githubConnectionState="connected" completed={false} /></SettingsProvider>
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
