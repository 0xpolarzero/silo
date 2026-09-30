import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { OnboardingApp } from "@/features/onboarding/onboarding-app"
import type { OnboardingActions, OnboardingSource } from "@/features/onboarding/model/onboarding-source"
import { createMemorySettingsStore, SettingsProvider, type SettingsStore } from "@/features/preferences/settings-store"
import { onboardingScenarios } from "@/fixtures/scenarios"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { fixtureApplicationCatalog } from "@/fixtures/application-catalog"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

const [real, other] = onboardingScenarios.complete.machineConfigurations
// The default seeded before the real sandboxes loaded: same name as a real one, another id.
const placeholder = { ...real, id: "00000000-0000-4000-8000-0000000000aa" }

function actions() {
  return { connectGitHub: vi.fn(), saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn(), submitStep: vi.fn() } satisfies OnboardingActions
}

function onboarding(store: SettingsStore, handlers: OnboardingActions, source: Partial<OnboardingSource>) {
  return <SettingsProvider store={store}><ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}><SystemIntegrationProvider store={createFixtureSystemIntegrationStore(store)}><OnboardingApp
    source={{ ...onboardingScenarios.running, ...source }}
    actions={handlers}
    githubConnectionState="disconnected"
    completed={false}
  /></SystemIntegrationProvider></ApplicationCatalogProvider></SettingsProvider>
}

describe("Finish blocked by a sandbox after setup", () => {
  const review = { currentStep: "review" as const, machines: [real], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: {} }
  const settledQueue = (["workspaceRun", "workspaceVerify"] as const).map((id) => ({ id, status: "succeeded" as const }))

  it("names a failed sandbox and offers to start it", async () => {
    const user = userEvent.setup()
    const handlers = { ...actions(), startWorkspace: vi.fn() }
    const message = `${real.name} is not running: Start failed. Start it to finish setup.`
    render(onboarding(createMemorySettingsStore({}, review), handlers, { ...onboardingScenarios.complete, readyToFinish: false, setupQueue: settledQueue, finishBlocker: { workspace: real.name, action: "start", message } }))
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled()
    expect(screen.getByRole("contentinfo", { name: "Onboarding actions" })).toHaveTextContent(`Needs attention · ${message}`)
    expect(screen.queryByText("Not started · Continue to start this step")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: `Start ${real.name}` }))
    expect(handlers.startWorkspace).toHaveBeenCalledWith(real.name)
  })

  it("offers to check an unconfirmed sandbox again", async () => {
    const user = userEvent.setup()
    const handlers = { ...actions(), refreshSetupState: vi.fn() }
    render(onboarding(createMemorySettingsStore({}, review), handlers, { ...onboardingScenarios.complete, readyToFinish: false, setupQueue: settledQueue, finishBlocker: { workspace: real.name, action: "refresh", message: `${real.name}'s status could not be confirmed. Check again to finish setup.` } }))
    expect(screen.getByRole("contentinfo", { name: "Onboarding actions" })).toHaveTextContent("Waiting · ")
    await user.click(screen.getByRole("button", { name: "Check again" }))
    expect(handlers.refreshSetupState).toHaveBeenCalledOnce()
  })
})

describe("onboarding with sandboxes that already exist", () => {
  it("replaces a placeholder seed with this computer's sandboxes once they load", () => {
    const store = createMemorySettingsStore()
    const handlers = actions()
    const view = render(onboarding(store, handlers, { machineConfigurations: [placeholder], machinesAuthoritative: false }))
    // A placeholder is not saved as the user's draft.
    expect(store.getSnapshot().onboardingDraft).toBeNull()
    view.rerender(onboarding(store, handlers, { machineConfigurations: [real, other], machinesAuthoritative: true, existingMachines: [real, other] }))
    expect(store.getSnapshot().onboardingDraft?.machines).toEqual([real, other])
    // Once seeded from real state it is not replaced again.
    view.rerender(onboarding(store, handlers, { machineConfigurations: [real], machinesAuthoritative: true, existingMachines: [real] }))
    expect(store.getSnapshot().onboardingDraft?.machines).toEqual([real, other])
  })

  it("asks before Continue would delete an existing sandbox, and keeping it restores it", async () => {
    const user = userEvent.setup()
    const store = createMemorySettingsStore({}, { currentStep: "workspaces", machines: [placeholder], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: {} })
    const handlers = actions()
    render(onboarding(store, handlers, { machineConfigurations: [real], existingMachines: [real] }))
    await user.click(screen.getByRole("button", { name: "Continue" }))
    const confirmation = screen.getByRole("alert", { name: "Confirm sandbox deletion" })
    expect(confirmation).toHaveTextContent(`Delete ${real.name}?`)
    expect(handlers.submitStep).not.toHaveBeenCalled()
    expect(screen.getByRole("tab", { name: /Sandboxes/ })).toHaveAttribute("aria-selected", "true")
    await user.click(within(confirmation).getByRole("button", { name: "Keep sandbox" }))
    // The placeholder with the same name gives way to the sandbox that exists.
    expect(handlers.submitStep).toHaveBeenCalledOnce()
    expect(handlers.submitStep).toHaveBeenCalledWith("workspaces", expect.objectContaining({ machineConfiguration: { schemaVersion: 1, machines: [real] } }))
    expect(store.getSnapshot().onboardingDraft?.machines).toEqual([real])
    expect(screen.getByRole("tab", { name: /GitHub/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("alert", { name: "Confirm sandbox deletion" })).not.toBeInTheDocument()
  })

  it("deletes an existing sandbox only after the user confirms it", async () => {
    const user = userEvent.setup()
    const added = { ...other, id: "7f3c2a10-4b5d-4e6f-8a9b-0c1d2e3f4a5b", name: "fresh" }
    const store = createMemorySettingsStore({}, { currentStep: "workspaces", machines: [added], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: {} })
    const handlers = actions()
    render(onboarding(store, handlers, { machineConfigurations: [real], existingMachines: [real] }))
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await user.click(screen.getByRole("button", { name: `Delete ${real.name}` }))
    expect(handlers.submitStep).toHaveBeenCalledWith("workspaces", expect.objectContaining({ machineConfiguration: { schemaVersion: 1, machines: [added] } }), { confirmedDeletions: [real.id] })
    // Later submissions carry the confirmation without asking again.
    await user.click(screen.getByRole("button", { name: "Continue" }))
    expect(screen.queryByRole("alert", { name: "Confirm sandbox deletion" })).not.toBeInTheDocument()
  })

  it("treats the list's own Delete confirmation as explicit", async () => {
    const user = userEvent.setup()
    const store = createMemorySettingsStore({}, { currentStep: "workspaces", machines: [real, other], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: {} })
    const handlers = actions()
    render(onboarding(store, handlers, { machineConfigurations: [real, other], existingMachines: [real, other] }))
    await user.click(screen.getByRole("button", { name: `Delete ${other.name}` }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    expect(screen.queryByRole("alert", { name: "Confirm sandbox deletion" })).not.toBeInTheDocument()
    expect(handlers.saveMachineConfiguration).toHaveBeenCalledWith({ schemaVersion: 1, machines: [real] }, { confirmedDeletions: [other.id] })
  })

  it("retries with the current draft, not the failed request", async () => {
    const user = userEvent.setup()
    const store = createMemorySettingsStore({}, { currentStep: "workspaces", machines: [real], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: { [real.name]: { name: "Edited", email: "edited@example.test", apply: true } } })
    const handlers = actions()
    render(onboarding(store, handlers, onboardingScenarios["bootstrap-failure"]))
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(handlers.retryWorkspaceSetup).toHaveBeenCalledWith(expect.objectContaining({
      machineConfiguration: { schemaVersion: 1, machines: [real] },
      github: expect.objectContaining({ workspaces: [expect.objectContaining({ workspace: real.name, identity: { name: "Edited", email: "edited@example.test", apply: true } })] }),
    }))
  })
})
