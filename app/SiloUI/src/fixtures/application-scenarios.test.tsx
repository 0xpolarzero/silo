import { describe, expect, it } from "vitest"

import {
  applicationSourceForScenario,
  githubManagementFixtureModeFromSearch,
  githubManagementFixtureModes,
  repositoryPushFixtureModeFromSearch,
  repositoryPushFixtureModes,
  computerConfigurationFixtureModeFromSearch,
  computerConfigurationFixtureModes,
  systemIssueFixtureModeFromSearch,
  systemIssueFixtureModes,
  computerFixtureModeFromSearch,
  computerFixtureModes,
} from "@/fixtures/application-scenarios"
import {
  activityCatalog,
  activityFixtureModeFromSearch,
  activityFixtureModes,
  activityFixtureStepCount,
  applicationActivitiesForFixture,
} from "@/fixtures/application-activity"

describe("application state fixtures", () => {
  it("parses and applies every computer state mode", () => {
    for (const mode of computerFixtureModes) {
      expect(computerFixtureModeFromSearch(`?computer-state=${mode}`)).toBe(mode)
      const source = applicationSourceForScenario("running", undefined, mode)
      const expectedState = mode === "error" ? "failed" : mode === "warning" ? "stopped" : mode
      expect(source.computers.every(({ state }) => state === expectedState)).toBe(true)
      expect(source.computers.every(({ attention }) => attention?.level === (mode === "warning" ? "warning" : mode === "error" ? "error" : undefined))).toBe(true)
    }
    expect(computerFixtureModeFromSearch("?computer-state=unknown")).toBeUndefined()
  })

  it("parses every computer configuration fixture independently from runtime state", () => {
    for (const mode of computerConfigurationFixtureModes) {
      expect(computerConfigurationFixtureModeFromSearch(`?computer-change=${mode}`)).toBe(mode)
      expect(applicationSourceForScenario("running", undefined, undefined, mode).computerConfigurationOperation).not.toBeNull()
    }
    expect(computerConfigurationFixtureModeFromSearch("?computer-change=unknown")).toBeUndefined()
  })

  it("parses and applies every system issue state independently", () => {
    for (const mode of systemIssueFixtureModes) {
      expect(systemIssueFixtureModeFromSearch(`?system-issue=${mode}`)).toBe(mode)
      expect(applicationSourceForScenario("running", undefined, undefined, undefined, mode).runtimeRepair).not.toBeNull()
    }
    expect(systemIssueFixtureModeFromSearch("?system-issue=unknown")).toBeUndefined()
    expect(applicationSourceForScenario("running").runtimeRepair).toBeNull()
    expect(applicationSourceForScenario("dependency-failure").runtimeRepair?.status).toBe("needed")
  })

  it("parses and applies every repository push state independently", () => {
    for (const mode of repositoryPushFixtureModes) {
      expect(repositoryPushFixtureModeFromSearch(`?repository-push=${mode}`)).toBe(mode)
      const source = applicationSourceForScenario("running", undefined, undefined, undefined, undefined, mode)
      expect(source.repositoryPushOperations).toEqual([expect.objectContaining({
        computer: "dev",
        repositoryPath: "acme/silo",
        commitCount: 2,
        status: mode,
      })])
    }
    expect(repositoryPushFixtureModeFromSearch("?repository-push=unknown")).toBeUndefined()
    expect(applicationSourceForScenario("running").repositoryPushOperations).toEqual([])
    expect(applicationSourceForScenario("running", undefined, undefined, undefined, undefined, "succeeded").computers[0].repositories[0].ahead).toBe(0)
  })

  it("parses and applies every GitHub management fixture independently", () => {
    for (const mode of githubManagementFixtureModes) {
      expect(githubManagementFixtureModeFromSearch(`?github-operation=${mode}`)).toBe(mode)
      const source = applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, mode)
      expect(source.github.computers).toHaveLength(3)
    }

    expect(githubManagementFixtureModeFromSearch("?github-operation=unknown")).toBeUndefined()
    expect(applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "disabled").github.accessEnabled).toBe(false)
    expect(applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "connected-empty").github.computers?.every(({ repositories }) => repositories.length === 0)).toBe(true)
    expect(applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "missing-device-identity").github.deviceIdentity).toBeNull()
    expect(applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "catalog-unavailable").github.repositoryCatalogStatus?.status).toBe("unavailable")
  })

  it("covers every activity category and presentation state", () => {
    expect(new Set(activityCatalog.map(({ category }) => category))).toEqual(new Set([
      "computer",
      "git",
      "backup",
      "secrets",
      "github",
      "system",
    ]))
    expect(new Set(activityCatalog.map(({ tone }) => tone))).toEqual(new Set([
      "neutral",
      "success",
      "danger",
      "warning",
    ]))
    expect(activityCatalog.every(({ status }) => status === "completed")).toBe(true)
  })

  it("parses every activity fixture and keeps one stable live row while it updates", () => {
    for (const mode of activityFixtureModes) {
      expect(activityFixtureModeFromSearch(`?activity=${mode}`)).toBe(mode)
      expect(applicationSourceForScenario("running", undefined, undefined, undefined, undefined, undefined, mode).activities.length).toBeGreaterThan(0)
    }
    expect(activityFixtureModeFromSearch("?activity=unknown")).toBeUndefined()

    for (const mode of activityFixtureModes.filter((candidate) => candidate !== "catalog")) {
      const first = applicationActivitiesForFixture(mode, 0, [])
      const final = applicationActivitiesForFixture(mode, activityFixtureStepCount(mode) - 1, [])
      expect(first[0].id).toBe(final[0].id)
      expect(first[0].status).toBe("running")
      expect(final[0].status).toBe("completed")
    }
  })
})
