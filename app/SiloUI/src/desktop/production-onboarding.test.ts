import { describe, expect, it, vi } from "vitest"

import { onboardingScenarios } from "@/fixtures/scenarios"
import { projectOnboarding } from "@/features/onboarding/model/onboarding-state"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { OnboardingCompletionRequest } from "@/features/onboarding/model/onboarding-source"
import { finishProductionOnboarding, productionOnboardingSource } from "./production-onboarding"

const application = applicationSourceForScenario("running")
const request: OnboardingCompletionRequest = {
  machineConfiguration: { schemaVersion: 1, machines: application.workspaces.map(({ machine }) => machine) },
  applications: application.preferences,
  github: { connectionState: "disconnected", workspaces: [] },
}

describe("production onboarding", () => {
  it("projects only live dependency and machine state", () => {
    const checks = [{ id: "system-os", title: "Supported OS", status: "pass" as const, detail: "macOS", remediation: null }]
    const source = productionOnboardingSource(application, { checks, retry: vi.fn() }, application.preferences)
    expect(source.preflightChecks).toBe(checks)
    expect(source.machineConfigurations).toEqual(application.workspaces.map(({ machine }) => machine))
    expect(source.bootstrapResult?.message).toBe("Sandbox configuration verified.")
    expect(source.bootstrapState.completedPhases).not.toContain("identity")
    expect(source.bootstrapState.completedPhases).not.toContain("github")
    expect(source.readyToFinish).toBe(true)
  })

  it("enables Finish after a real VM is configured without inventing progress events", () => {
    const native = { ...application, workspaces: [application.workspaces[0]] }
    const dependencies = { checks: onboardingScenarios.complete.preflightChecks, retry: vi.fn() }
    const current = productionOnboardingSource(native, dependencies, application.preferences)
    const view = projectOnboarding(current, "disconnected")
    expect(view.finishEnabled).toBe(true)
    expect(view.workspaceProgress.workspaces[0].status).toBe("ready")
    expect(view.workspaceProgress.completedOperations).toBe(2)
    expect(view.workspaceProgress.totalOperations).toBe(2)
    expect(current.progressEvents).toEqual([])
    expect(projectOnboarding(productionOnboardingSource(null, dependencies, application.preferences), "disconnected").finishEnabled).toBe(false)
  })

  it("keeps dependency onboarding available when runtime state cannot load", () => {
    const checks = [{ id: "runtime-microsandbox", title: "MicroSandbox", status: "failed" as const, detail: "Bundled runtime missing", remediation: null }]
    const source = productionOnboardingSource(null, { checks, retry: vi.fn() }, application.preferences)
    expect(source.preflightChecks).toBe(checks)
    expect(source.machineConfigurations).toEqual([])
    expect(source.bootstrapResult).toBeNull()
  })

  it("persists completion only after native machine configuration succeeds", async () => {
    const markComplete = vi.fn(async () => {})
    const configureMachines = vi.fn(async () => application)
    const configureIdentities = vi.fn(async () => {})
    await finishProductionOnboarding({ configureMachines, configureIdentities } as never, request, markComplete)
    expect(configureMachines).toHaveBeenCalledWith(request.machineConfiguration)
    expect(markComplete).toHaveBeenCalledOnce()

    configureMachines.mockRejectedValueOnce(new Error("create failed"))
    markComplete.mockClear()
    await expect(finishProductionOnboarding({ configureMachines, configureIdentities } as never, request, markComplete)).rejects.toThrow("create failed")
    expect(markComplete).not.toHaveBeenCalled()
  })
  it("does not complete onboarding if identity application fails", async () => {
    const markComplete = vi.fn(async () => {})
    const configureMachines = vi.fn(async () => application)
    const configureIdentities = vi.fn(async () => { throw new Error("identity verification failed") })
    await expect(finishProductionOnboarding({ configureMachines, configureIdentities } as never, request, markComplete)).rejects.toThrow("identity verification failed")
    expect(markComplete).not.toHaveBeenCalled()
  })

  it("rejects unsupported repository requests before changing any VM", async () => {
    const configureMachines = vi.fn()
    const marked = vi.fn()
    await expect(finishProductionOnboarding({ configureMachines } as never, { ...request, github: { connectionState: "disconnected", workspaces: [{ workspace: "dev", repositories: [{ repository: "example/repo", allowPushes: false }], identity: { name: "", email: "", apply: false } }] } }, marked)).rejects.toThrow("Repository setup is not available yet")
    expect(configureMachines).not.toHaveBeenCalled()
    expect(marked).not.toHaveBeenCalled()
  })

})
