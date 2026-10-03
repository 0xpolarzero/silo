import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { OnboardingAppProps } from "@/features/onboarding/onboarding-app"
import { onboardingScenarios } from "@/fixtures/scenarios"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { OnboardingCompletionRequest } from "@/features/onboarding/model/onboarding-source"
import type { SetupMachineConfigurationRequest } from "@/contracts/silo"
import type { ProductionSource } from "./production-source"
import { projectOnboarding } from "@/features/onboarding/model/onboarding-state"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { ProductionOnboarding } from "./production-onboarding"

const captured = vi.hoisted(() => ({ props: null as OnboardingAppProps | null }))
vi.mock("@/features/onboarding/onboarding-app", () => ({ OnboardingApp: (props: OnboardingAppProps) => { captured.props = props; return <div>{props.source.error?.message ?? "No error"}</div> } }))
vi.mock("./production-source", async (original) => ({ ...await original<typeof import("./production-source")>(), useProductionSource: () => ({ setupQueue: [], setupEvents: [], setupCandidate: null, backup: { state: {} } }) }))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const application = applicationSourceForScenario("running")
const requestA: SetupMachineConfigurationRequest = { schemaVersion: 1, machines: application.workspaces.map(({ machine }) => machine) }
const requestB: SetupMachineConfigurationRequest = { ...requestA, machines: [requestA.machines[0]] }
// requestB drops the other VMs: the list's own Delete confirmation confirmed that.
const dropped = { confirmedDeletions: requestA.machines.slice(1).map(({ id }) => id) }
const dependencies = { checks: [], retry: vi.fn() }

describe("production onboarding submission errors", () => {
  it("passes connected token availability to onboarding independently of OAuth", () => {
    const source = { applicationActions: {} } as unknown as ProductionSource
    const connected = { ...application, github: { ...application.github, personalToken: { state: "connected" as const, saved: true } } }
    const view = render(<ProductionOnboarding application={connected} dependencies={dependencies} source={source} />)
    expect(captured.props!.tokenConnected).toBe(true)
    view.rerender(<ProductionOnboarding application={application} dependencies={dependencies} source={source} />)
    expect(captured.props!.tokenConnected).toBe(false)
  })

  it("passes an intentionally empty restored draft to identity verification", () => {
    const store = createMemorySettingsStore({}, { currentStep: "review", machines: [], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: {} })
    const verifySetupIdentities = vi.fn().mockResolvedValue(undefined)
    const source = { verifySetupIdentities, applicationActions: {} } as unknown as ProductionSource
    render(<SettingsProvider store={store}><ProductionOnboarding application={application} dependencies={dependencies} source={source} /></SettingsProvider>)
    expect(verifySetupIdentities).toHaveBeenCalledWith({ machineConfiguration: { schemaVersion: 1, machines: [] }, github: { connectionState: application.github.state, workspaces: [] } })
  })

  it("verifies an omitted identity for a recovered sandbox named constructor as unapplied", () => {
    const machine = { ...requestB.machines[0], name: "constructor" }
    const store = createMemorySettingsStore({}, { currentStep: "review", machines: [machine], unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: {} })
    const verifySetupIdentities = vi.fn().mockResolvedValue(undefined)
    const source = { verifySetupIdentities, applicationActions: {} } as unknown as ProductionSource
    render(<SettingsProvider store={store}><ProductionOnboarding application={application} dependencies={dependencies} source={source} /></SettingsProvider>)

    expect(verifySetupIdentities).toHaveBeenCalledWith({
      machineConfiguration: { schemaVersion: 1, machines: [machine] },
      github: { connectionState: application.github.state, workspaces: [{ workspace: "constructor", repositories: [], identity: { name: "", email: "", apply: false } }] },
    })
  })

  it("ignores an older rejection while the newer submission succeeds", async () => {
    const first = deferred()
    const second = deferred()
    const configureMachines = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const source = { configureMachines, applicationActions: {} } as unknown as ProductionSource
    render(<ProductionOnboarding application={application} dependencies={dependencies} source={source} />)
    act(() => captured.props!.actions.saveMachineConfiguration(requestA))
    act(() => captured.props!.actions.saveMachineConfiguration(requestB, dropped))
    await act(async () => { first.reject(new Error("Old failure")); await first.promise.catch(() => {}) })
    expect(screen.getByText("No error")).toBeVisible()
    await act(async () => { second.resolve(); await second.promise })
    expect(screen.getByText("No error")).toBeVisible()
  })

  it("keeps the failed VM identity when the local promise also rejects", async () => {
    const failed = deferred()
    const source = { configureMachines: vi.fn(() => failed.promise), applicationActions: {} } as unknown as ProductionSource
    const error = { code: "native_bridge_failed", message: "Creation failed", recovery: "Retry", workspace: requestB.machines[0].name, retryable: true }
    const current = { ...application, sandboxConfigurationOperation: { id: "failed", status: "failed", candidate: requestB, progressEvents: [], result: null, error } } as typeof application
    render(<ProductionOnboarding application={current} dependencies={dependencies} source={source} />)
    act(() => captured.props!.actions.saveMachineConfiguration(requestB, dropped))
    await act(async () => { failed.reject(new Error("Creation failed")); await failed.promise.catch(() => {}) })
    expect(captured.props!.source.error?.workspace).toBe(requestB.machines[0].name)
    const progress = projectOnboarding({ ...captured.props!.source, progressEvents: [{ ...onboardingScenarios.running.progressEvents[0], workspace: requestB.machines[0].name, step: "workspace-configuration", fraction: 0 }] }, "disconnected").workspaceProgress
    expect(progress.workspaces[0]).toMatchObject({ name: requestB.machines[0].name, status: "failed", detail: "Creation failed" })
    expect(progress.workingCount).toBe(0)
  })

  it("retries the newest submitted configuration before an older native candidate", async () => {
    const configureMachines = vi.fn().mockResolvedValue(application)
    const source = { configureMachines, applicationActions: {} } as unknown as ProductionSource
    const older = { ...application, sandboxConfigurationOperation: { id: "old", status: "applying", candidate: requestA, progressEvents: [], result: null, error: null } } as typeof application
    render(<ProductionOnboarding application={older} dependencies={dependencies} source={source} />)
    await act(async () => { captured.props!.actions.saveMachineConfiguration(requestB, dropped); await Promise.resolve() })
    await act(async () => { captured.props!.actions.retryWorkspaceSetup(); await Promise.resolve() })
    expect(configureMachines).toHaveBeenLastCalledWith(requestB)
  })

  it("retries the submitted Git identity step instead of sandbox configuration", async () => {
    const request: OnboardingCompletionRequest = { machineConfiguration: requestA, applications: application.preferences, github: { connectionState: "disconnected", workspaces: [] } }
    const submitSetupStep = vi.fn().mockRejectedValueOnce(new Error("Identity verification failed")).mockResolvedValue(undefined)
    const configureMachines = vi.fn()
    const source = { submitSetupStep, configureMachines, applicationActions: {} } as unknown as ProductionSource
    render(<ProductionOnboarding application={application} dependencies={dependencies} source={source} />)
    await act(async () => { captured.props!.actions.submitStep!("github", request) })
    expect(screen.getByText("Identity verification failed")).toBeVisible()
    await act(async () => { captured.props!.actions.retryWorkspaceSetup() })
    expect(submitSetupStep).toHaveBeenCalledTimes(2)
    expect(submitSetupStep).toHaveBeenLastCalledWith("github", request)
    expect(configureMachines).not.toHaveBeenCalled()
    expect(screen.getByText("No error")).toBeVisible()
  })

  it("retries Finish and shows completion only after the settings callback succeeds", async () => {
    const request: OnboardingCompletionRequest = { machineConfiguration: requestA, applications: application.preferences, github: { connectionState: "disconnected", workspaces: [] } }
    const finishSetup = vi.fn().mockRejectedValueOnce(new Error("Settings write failed")).mockImplementation(async (_request, save: () => Promise<void>) => save())
    const configureMachines = vi.fn()
    const onOpenApp = vi.fn()
    const source = { finishSetup, configureMachines, applicationActions: {} } as unknown as ProductionSource
    render(<ProductionOnboarding application={application} dependencies={dependencies} source={source} onOpenApp={onOpenApp} />)
    await act(async () => { captured.props!.actions.finishSetup(request) })
    expect(screen.getByText("Settings write failed")).toBeVisible()
    expect(captured.props!.completed).toBe(false)
    await act(async () => { captured.props!.actions.retryWorkspaceSetup() })
    expect(finishSetup).toHaveBeenCalledTimes(2)
    expect(finishSetup).toHaveBeenLastCalledWith(request, expect.any(Function))
    expect(configureMachines).not.toHaveBeenCalled()
    expect(screen.getByText("No error")).toBeVisible()
    expect(captured.props!.completed).toBe(true)
    expect(captured.props!.onOpenApp).toBe(onOpenApp)
  })


  it("never sends a delete for an existing VM the user did not confirm deleting", async () => {
    const configureMachines = vi.fn().mockResolvedValue(application)
    const submitSetupStep = vi.fn().mockResolvedValue(undefined)
    const finishSetup = vi.fn().mockResolvedValue(undefined)
    // The committed list is read from the source when submitting, not from a stale prop.
    const source = { configureMachines, submitSetupStep, finishSetup, getSnapshot: () => ({ source: application }), applicationActions: {} } as unknown as ProductionSource
    render(<ProductionOnboarding application={null} dependencies={dependencies} source={source} />)
    const request: OnboardingCompletionRequest = { machineConfiguration: requestB, applications: application.preferences, github: { connectionState: "disconnected", workspaces: [] } }
    await act(async () => { captured.props!.actions.saveMachineConfiguration(requestB) })
    expect(screen.getByText(/Setup did not delete .*No sandbox changed\./)).toBeVisible()
    await act(async () => { captured.props!.actions.submitStep!("workspaces", request) })
    await act(async () => { captured.props!.actions.finishSetup(request) })
    await act(async () => { captured.props!.actions.retryWorkspaceSetup(request) })
    expect(configureMachines).not.toHaveBeenCalled()
    expect(submitSetupStep).not.toHaveBeenCalled()
    expect(finishSetup).not.toHaveBeenCalled()
    await act(async () => { captured.props!.actions.submitStep!("workspaces", request, dropped) })
    expect(submitSetupStep).toHaveBeenCalledWith("workspaces", request)
  })

  it("retries a failed step with the current draft instead of the failed request", async () => {
    const failed: OnboardingCompletionRequest = { machineConfiguration: requestA, applications: application.preferences, github: { connectionState: "disconnected", workspaces: [{ workspace: requestA.machines[0].name, repositories: [], identity: { name: "Old", email: "old@example.invalid", apply: true } }] } }
    const edited: OnboardingCompletionRequest = { ...failed, github: { ...failed.github, workspaces: [{ ...failed.github.workspaces[0], identity: { name: "New", email: "new@example.invalid", apply: true } }] } }
    const submitSetupStep = vi.fn().mockRejectedValueOnce(new Error("Identity verification failed")).mockResolvedValue(undefined)
    const source = { submitSetupStep, applicationActions: {} } as unknown as ProductionSource
    render(<ProductionOnboarding application={application} dependencies={dependencies} source={source} />)
    await act(async () => { captured.props!.actions.submitStep!("github", failed) })
    await act(async () => { captured.props!.actions.retryWorkspaceSetup(edited) })
    expect(submitSetupStep).toHaveBeenLastCalledWith("github", edited)
    // A configuration failure retried from the current draft uses its sandboxes.
    const configureMachines = vi.fn().mockRejectedValueOnce(new Error("Creation failed")).mockResolvedValue(application)
    Object.assign(source, { configureMachines })
    await act(async () => { captured.props!.actions.saveMachineConfiguration(requestA) })
    await act(async () => { captured.props!.actions.retryWorkspaceSetup({ ...edited, machineConfiguration: requestB }, dropped) })
    expect(configureMachines).toHaveBeenLastCalledWith(requestB)
  })

  it("verifies the saved draft identity when onboarding is restored", async () => {
    const machine = requestB.machines[0]
    const identity = { name: "Saved author", email: "saved@example.invalid", apply: true }
    const draft = { currentStep: "review" as const, machines: requestB.machines, unfinishedMachineEditor: null, workspaceSelections: {}, workspaceIdentities: { [machine.name]: identity } }
    const store = createMemorySettingsStore({}, draft)
    const verifySetupIdentities = vi.fn().mockResolvedValue(undefined)
    const source = { verifySetupIdentities, applicationActions: {} } as unknown as ProductionSource
    render(<SettingsProvider store={store}><ProductionOnboarding application={application} dependencies={dependencies} source={source} /></SettingsProvider>)
    expect(verifySetupIdentities).toHaveBeenCalledWith({ machineConfiguration: requestB, github: { connectionState: application.github.state, workspaces: [{ workspace: machine.name, repositories: [], identity }] } })
    const changed = { ...identity, email: "changed@example.invalid" }
    await act(async () => { await store.updateOnboardingDraft({ ...draft, workspaceIdentities: { [machine.name]: changed } }) })
    expect(verifySetupIdentities).toHaveBeenLastCalledWith(expect.objectContaining({ github: expect.objectContaining({ workspaces: [{ workspace: machine.name, repositories: [], identity: changed }] }) }))
  })

})

describe("remote computer onboarding", () => {
  it("connects and completes onboarding without submitting local VM configuration", async () => {
    const connectComputer = vi.fn().mockResolvedValue(undefined)
    const configureMachines = vi.fn()
    const onOpenApp = vi.fn()
    const store = createMemorySettingsStore()
    const source = { configureMachines, applicationActions: { connectComputer } } as unknown as ProductionSource
    render(<SettingsProvider store={store}><ProductionOnboarding application={null} dependencies={{ checks: [{ id: "runtime-microsandbox", title: "Runtime", status: "unavailable", detail: "Not installed", remediation: null }], retry: vi.fn() }} source={source} onOpenApp={onOpenApp} /></SettingsProvider>)
    act(() => captured.props!.onConnectComputer!())
    fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: "owner@office" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(onOpenApp).toHaveBeenCalledOnce())
    expect(connectComputer).toHaveBeenCalledWith("owner@office")
    expect(configureMachines).not.toHaveBeenCalled()
    expect(store.getSnapshot().settings.onboardingComplete).toBe(true)
  })

  it("keeps setup incomplete when the remote connection fails", async () => {
    const connectComputer = vi.fn().mockRejectedValue(new Error("Offline · last known status"))
    const onOpenApp = vi.fn()
    const store = createMemorySettingsStore()
    const source = { applicationActions: { connectComputer } } as unknown as ProductionSource
    render(<SettingsProvider store={store}><ProductionOnboarding application={null} dependencies={dependencies} source={source} onOpenApp={onOpenApp} /></SettingsProvider>)
    act(() => captured.props!.onConnectComputer!())
    fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: "owner@office" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline · last known status")
    expect(store.getSnapshot().settings.onboardingComplete).toBe(false)
    expect(onOpenApp).not.toHaveBeenCalled()
  })
})
