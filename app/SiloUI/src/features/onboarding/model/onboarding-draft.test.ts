import { describe, expect, it } from "vitest"

import { fixtureMachineDefaults } from "@/fixtures/machine-configurations"
import { onboardingDraftSchema } from "@/features/onboarding/model/onboarding-draft"

const draft = {
  currentStep: "workspaces",
  machines: fixtureMachineDefaults,
  unfinishedMachineEditor: null,
  workspaceSelections: { dev: [{ repository: "acme/silo", allowPushes: false }] },
  workspaceIdentities: { dev: { name: "", email: "unfinished@", apply: false } },
}

describe("onboarding recovery validation", () => {
  it("persists all-repository intent without expanding it into the current catalog", () => {
    const input = { ...draft, workspaceRepositoryAccess: { dev: { repositoryMode: "all", allRepositoriesAllowChanges: false } } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
    expect(onboardingDraftSchema.safeParse({ ...input, workspaceRepositoryAccess: { dev: { repositoryMode: "all", allRepositoriesAllowChanges: "yes" } } }).success).toBe(false)
  })

  it("keeps incomplete editor values without weakening saved machine validation", () => {
    const input = { ...draft, unfinishedMachineEditor: {
      draft: { id: crypto.randomUUID(), kind: "ssh", name: "", host: "", user: "not yet valid", port: 0 },
      insertAt: 3,
    } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
    expect(onboardingDraftSchema.safeParse({ ...draft, machines: [input.unfinishedMachineEditor.draft] }).success).toBe(false)
  })

  it("keeps temporarily invalid VM resource combinations for correction after restart", () => {
    const input = { ...draft, unfinishedMachineEditor: {
      draft: { ...fixtureMachineDefaults[0], name: "", cpus: 12, maxCPUs: 4 },
      originalID: fixtureMachineDefaults[0].id,
      insertAt: 0,
    } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
  })

  it("rejects credentials, connection state, and runtime progress as recovery data", () => {
    for (const unsafe of [{ token: "secret" }, { githubConnectionState: "connected" }, { completed: true }, { progressEvents: [] }]) {
      expect(onboardingDraftSchema.safeParse({ ...draft, ...unsafe }).success).toBe(false)
    }
  })

  it("rejects duplicate saved machine IDs and preserves empty choices and explicit false", () => {
    expect(onboardingDraftSchema.safeParse({ ...draft, machines: [fixtureMachineDefaults[0], fixtureMachineDefaults[0]] }).success).toBe(false)
    const input = { ...draft, workspaceSelections: { dev: [] } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
  })
})
