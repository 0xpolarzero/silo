import { describe, expect, it } from "vitest"

import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { onboardingDraftSchema } from "@/features/onboarding/model/onboarding-draft"

const draft = {
  currentStep: "workspaces",
  machines: productionMachineDefaults,
  unfinishedMachineEditor: null,
  workspaceSelections: { dev: [{ repository: "acme/silo", allowPushes: false }] },
  workspaceIdentities: { dev: { name: "", email: "unfinished@", apply: false } },
}

describe("onboarding recovery validation", () => {
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
      draft: { ...productionMachineDefaults[0], name: "", cpus: 12, maxCPUs: 4 },
      originalID: productionMachineDefaults[0].id,
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
    expect(onboardingDraftSchema.safeParse({ ...draft, machines: [productionMachineDefaults[0], productionMachineDefaults[0]] }).success).toBe(false)
    const input = { ...draft, workspaceSelections: { dev: [] } }
    expect(onboardingDraftSchema.parse(input)).toEqual(input)
  })
})
