import { describe, expect, it, vi } from "vitest"

import { onboardingScenarios } from "@/fixtures/scenarios"
import { projectOnboarding } from "@/features/onboarding/model/onboarding-state"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { productionOnboardingSource } from "./production-onboarding"

const application = applicationSourceForScenario("running")
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

})
