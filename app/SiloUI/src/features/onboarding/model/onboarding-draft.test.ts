import { describe, expect, it } from "vitest"

import { fixtureComputerDefaults } from "@/fixtures/computer-configurations"
import { onboardingDraftSchema } from "@/features/onboarding/model/onboarding-draft"

const draft = {
  currentStep: "computers",
  configurations: fixtureComputerDefaults,
  unfinishedComputerEditor: null,
  computerSelections: { dev: [{ repository: "acme/silo", allowPushes: false }] },
  computerIdentities: { dev: { name: "", email: "unfinished@", apply: false } },
}

describe("onboarding recovery validation", () => {
  it.each(["token", "oauth"])("persists %s authentication without storing credentials", (authenticationMethod) => {
    const input = { ...draft, computerRepositoryAccess: { dev: { repositoryMode: "selected", allRepositoriesAllowChanges: false, authenticationMethod } } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
    expect(onboardingDraftSchema.safeParse({ ...input, computerRepositoryAccess: { dev: { ...input.computerRepositoryAccess.dev, token: "secret" } } }).success).toBe(false)
  })

  it("persists all-repository intent without expanding it into the current catalog", () => {
    const input = { ...draft, computerRepositoryAccess: { dev: { repositoryMode: "all", allRepositoriesAllowChanges: false } } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
    expect(onboardingDraftSchema.safeParse({ ...input, computerRepositoryAccess: { dev: { repositoryMode: "all", allRepositoriesAllowChanges: "yes" } } }).success).toBe(false)
  })

  it("keeps incomplete editor values without weakening saved configuration validation", () => {
    const input = { ...draft, unfinishedComputerEditor: {
      draft: { ...fixtureComputerDefaults[0], id: crypto.randomUUID(), name: "Not yet valid", cpus: 0 },
      insertAt: 3,
    } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
    expect(onboardingDraftSchema.safeParse({ ...draft, configurations: [input.unfinishedComputerEditor.draft] }).success).toBe(false)
  })

  it("keeps temporarily invalid VM resource combinations for correction after restart", () => {
    const input = { ...draft, unfinishedComputerEditor: {
      draft: { ...fixtureComputerDefaults[0], name: "", cpus: 12, maxCPUs: 4 },
      originalID: fixtureComputerDefaults[0].id,
      insertAt: 0,
    } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
  })

  it("rejects credentials, connection state, and runtime progress as recovery data", () => {
    for (const unsafe of [{ token: "secret" }, { githubConnectionState: "connected" }, { completed: true }, { progressEvents: [] }]) {
      expect(onboardingDraftSchema.safeParse({ ...draft, ...unsafe }).success).toBe(false)
    }
  })

  it("rejects duplicate saved configuration IDs and preserves empty choices and explicit false", () => {
    expect(onboardingDraftSchema.safeParse({ ...draft, configurations: [fixtureComputerDefaults[0], fixtureComputerDefaults[0]] }).success).toBe(false)
    const input = { ...draft, computerSelections: { dev: [] } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
  })
})
