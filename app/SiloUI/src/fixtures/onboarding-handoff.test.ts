import { describe, expect, it } from "vitest"

import { applicationPreviewAfterSetup } from "./onboarding-handoff"
import { fixtureComputerDefaults } from "@/fixtures/computer-configurations"
import type { OnboardingCompletionRequest } from "@/features/onboarding/model/onboarding-source"

const request: OnboardingCompletionRequest = {
  computerConfiguration: { schemaVersion: 1, computers: [
    { ...fixtureComputerDefaults[0], name: "build" },
    { ...fixtureComputerDefaults[1], name: "remote" },
  ] },
  applications: { terminal: "Warp", editor: "Zed", browser: "Firefox" },
  github: { connectionState: "connected", computers: [
    { computer: "build", identity: { name: "Example", email: "example@example.test", apply: true }, repositories: [{ repository: "acme/design-system", allowPushes: true }] },
    { computer: "remote", identity: { name: "", email: "", apply: false }, repositories: [] },
  ] },
}

describe("setup preview handoff", () => {
  it("opens the configured configurations, application choices and exact repository policy", () => {
    const app = applicationPreviewAfterSetup(request)
    expect(app.computers.map(({ configuration }) => configuration)).toEqual(request.computerConfiguration.computers)
    expect(app.preferences).toMatchObject(request.applications)
    expect(app.github.computers).toEqual(request.github.computers)
    expect(app.computers[0].githubRepositories).toEqual(["acme/design-system"])
    expect(app.secrets).toEqual([])
    expect(app.backup.lastArchive).toBe("")
    expect(app.backup.destination).toBe("")
    expect(app.runtimeRepair).toBeNull()
    expect(app.computerConfigurationOperation).toBeNull()
    expect(app.repositoryPushOperations).toEqual([])
  })

  it("retains a disconnected choice without importing the sample account or policies", () => {
    const app = applicationPreviewAfterSetup({ ...request, github: { ...request.github, connectionState: "disconnected" } })
    expect(app.github.state).toBe("disconnected")
    expect(app.github.account).toBeUndefined()
    expect(app.github.accessEnabled).toBe(false)
    expect(app.github.computers).toEqual(request.github.computers)
  })
})
