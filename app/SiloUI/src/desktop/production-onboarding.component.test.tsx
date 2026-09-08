import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { OnboardingAppProps } from "@/features/onboarding/onboarding-app"
import { onboardingScenarios } from "@/fixtures/scenarios"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { SetupMachineConfigurationRequest } from "@/contracts/silo"
import type { ProductionSource } from "./production-source"
import { projectOnboarding } from "@/features/onboarding/model/onboarding-state"
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
const dependencies = { checks: [], retry: vi.fn() }

describe("production onboarding submission errors", () => {
  it("ignores an older rejection while the newer submission succeeds", async () => {
    const first = deferred()
    const second = deferred()
    const configureMachines = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const source = { configureMachines, applicationActions: {} } as unknown as ProductionSource
    render(<ProductionOnboarding application={application} dependencies={dependencies} source={source} />)
    act(() => captured.props!.actions.saveMachineConfiguration(requestA))
    act(() => captured.props!.actions.saveMachineConfiguration(requestB))
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
    act(() => captured.props!.actions.saveMachineConfiguration(requestB))
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
    await act(async () => { captured.props!.actions.saveMachineConfiguration(requestB); await Promise.resolve() })
    await act(async () => { captured.props!.actions.retryWorkspaceSetup(); await Promise.resolve() })
    expect(configureMachines).toHaveBeenLastCalledWith(requestB)
  })
})
