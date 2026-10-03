import { describe, expect, it } from "vitest"

import { projectOnboarding } from "@/features/onboarding/model/onboarding-state"
import { fixtureComputerDefaults } from "@/fixtures/computer-configurations"
import { onboardingScenarios, scenarioFromSearch, scenarioNames } from "@/fixtures/scenarios"

// Fixtures must exercise the UI with the same configurations that progress describes.
describe("onboarding scenario coherence", () => {
  it.each(scenarioNames)("keeps configuration and progress configurations aligned in %s", (name) => {
    const source = onboardingScenarios[name]
    const configurations = source.computerConfigurations
    const names = configurations.map((configuration) => configuration.name)
    expect(source.bootstrapConfiguration.computers.map((computer) => computer.name)).toEqual(names)
    expect(source.bootstrapConfiguration.computers).toEqual(configurations.map((configuration) => ({
      name: configuration.name,
      cpu: configuration.cpus,
      cpuCeiling: configuration.maxCPUs,
      memoryGiB: configuration.memoryGiB,
      memoryCeilingGiB: configuration.maxMemoryGiB,
      workspaceStorageGiB: configuration.workspaceStorageGiB,
      runtimeStorageGiB: configuration.runtimeStorageGiB,
    })))
    for (const event of source.progressEvents) {
      if (event.computer) expect(names).toContain(event.computer)
    }
    if (source.error?.computer) expect(names).toContain(source.error.computer)
    if (name !== "stress-running") expect(source.computerConfigurations).toEqual(fixtureComputerDefaults)
  })

  it("shows the default three configurations and an unfinished verification", () => {
    const { computerProgress: progress } = projectOnboarding(onboardingScenarios.running, "connected")
    expect(progress).toMatchObject({
      completedOperations: 8, totalOperations: 9, fraction: 8 / 9,
      currentComputer: "personal", readyCount: 2, workingCount: 1, waitingCount: 0, failedCount: 0,
    })
    expect(progress.computers.find(({ name }) => name === "personal")?.status).toBe("working")
    expect(progress.visibleEvents.every(({ safeForDisplay }) => safeForDisplay)).toBe(true)
  })

  it("fails the visible playgrounds configuration and completes only real operations", () => {
    const { computerProgress: progress } = projectOnboarding(onboardingScenarios["bootstrap-failure"], "connected")
    expect(progress).toMatchObject({
      completedOperations: 4, totalOperations: 9, currentComputer: "playgrounds", failedCount: 1,
    })
    expect(progress.computers.find(({ name }) => name === "playgrounds")?.status).toBe("failed")
    expect(projectOnboarding(onboardingScenarios.complete, "connected").computerProgress).toMatchObject({
      completedOperations: 9, totalOperations: 9, fraction: 1, readyCount: 3,
    })
  })

  it("keeps the twelve-computer stress scenario explicit and selectable", () => {
    expect(scenarioFromSearch("?scenario=stress-running")).toBe("stress-running")
    expect(onboardingScenarios["stress-running"].computerConfigurations).toHaveLength(12)
    expect(projectOnboarding(onboardingScenarios["stress-running"], "connected").computerProgress).toMatchObject({
      completedOperations: 27, totalOperations: 36, currentComputer: "docs-build",
      readyCount: 3, workingCount: 1, waitingCount: 8,
    })
  })
})
