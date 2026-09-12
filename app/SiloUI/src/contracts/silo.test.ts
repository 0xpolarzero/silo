import { machineEditorDraftSchema } from "@/features/onboarding/model/onboarding-draft"
import { describe, expect, it } from "vitest"

import {
  githubWorkspacePolicySchema,
  setupMachineConfigurationRequestSchema,
  setupWorkspaceConfigurationSchema,
  siloProgressEventSchema,
} from "@/contracts/silo"
import { onboardingSourceSchema } from "@/features/onboarding/model/onboarding-source"
import { fixtureMachineDefaults } from "@/fixtures/machine-configurations"
import { onboardingScenarios, scenarioNames } from "@/fixtures/scenarios"

describe("Silo contract fixtures", () => {
  it("parses every scenario through strict runtime contracts", () => {
    for (const name of scenarioNames) {
      expect(onboardingSourceSchema.parse(onboardingScenarios[name])).toEqual(onboardingScenarios[name])
    }
  })

  it("accepts an explicit optional host Git identity without reading local configuration", () => {
    expect(onboardingSourceSchema.parse({
      ...onboardingScenarios.running,
      currentHostGitIdentity: null,
    }).currentHostGitIdentity).toBeNull()
    expect(onboardingScenarios.running.currentHostGitIdentity).toEqual({
      name: "Taylor Example",
      email: "taylor@example.com",
    })
  })

  it("keeps progress events on the exact schema-version 1 contract", () => {
    const event = onboardingScenarios.running.progressEvents.at(-1)
    expect(event).toMatchObject({
      schemaVersion: 1,
      type: "progress",
      requestId: "setup-bootstrap-20260903",
      phase: "verification",
      step: "workspace-verification",
      workspace: "personal",
      fraction: 0,
      message: "Verifying 'personal'.",
      safeForDisplay: true,
    })
    expect(event?.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(onboardingScenarios.running.bootstrapState).toMatchObject({
      phase: "workspaces",
      startedAt: expect.any(Number),
      updatedAt: expect.any(Number),
      phaseDurations: expect.any(Object),
    })
  })

  it("rejects unknown keys and a numeric progress revision", () => {
    const valid = onboardingScenarios.running.progressEvents.at(-1)
    expect(() => siloProgressEventSchema.parse({ ...valid, inventedCaption: "no" })).toThrow()
    expect(() => siloProgressEventSchema.parse({ ...valid, revision: 1 })).toThrow()
  })

  it("enforces the native workspace and repository invariants", () => {
    expect(() => setupWorkspaceConfigurationSchema.parse({
      ...onboardingScenarios.complete.bootstrapState.workspaceConfigurations?.[0],
      cpus: 12,
      maxCPUs: 4,
    })).toThrow("cpus must not exceed maxCPUs")

    expect(() => githubWorkspacePolicySchema.parse({
      ...onboardingScenarios.running.githubPolicies[0],
      repositories: [{
        ...onboardingScenarios.running.githubPolicies[0].repositories[0],
        workspace: "personal",
      }],
    })).toThrow("repository workspaces must match the policy workspace")
  })

  it("keeps the machine host-boundary request discriminated, ordered, and strict", () => {
    const request = setupMachineConfigurationRequestSchema.parse({
      schemaVersion: 1,
      machines: [
        fixtureMachineDefaults[1],
        {
          id: "00000000-0000-4000-8000-000000000100",
          kind: "ssh",
          name: "remote",
          host: "remote.example.com",
          user: "developer",
          port: 22,
        },
      ],
    })
    expect(request.machines.map(({ name }) => name)).toEqual(["playgrounds", "remote"])
    expect(request.machines.map(({ kind }) => kind)).toEqual(["vm", "ssh"])
    expect(() => setupMachineConfigurationRequestSchema.parse({
      ...request,
      machines: [{ ...request.machines[1], ignoredCredential: "secret" }],
    })).toThrow()
    expect(() => setupMachineConfigurationRequestSchema.parse({
      ...request,
      machines: [request.machines[0], { ...request.machines[1], name: "PLAYGROUNDS" }],
    })).toThrow()
    expect(() => setupMachineConfigurationRequestSchema.parse({
      ...request,
      machines: [request.machines[0], { ...request.machines[1], id: request.machines[0].id }],
    })).toThrow("machine IDs must be unique")
  })
})

describe("custom VM memory", () => {
  it.each([1, 2, 4, 8, 12, 24, 64])("accepts %i GiB through the saved configuration contract", (memory) => {
    const machine = { ...fixtureMachineDefaults[0], memoryGiB: memory, maxMemoryGiB: memory }
    expect(setupMachineConfigurationRequestSchema.safeParse({ schemaVersion: 1, machines: [machine] }).success).toBe(true)
  })
  it.each([0, -1, 1.5, 4294967296])("rejects invalid memory %s", (memory) => {
    const machine = { ...fixtureMachineDefaults[0], memoryGiB: memory, maxMemoryGiB: memory }
    expect(setupMachineConfigurationRequestSchema.safeParse({ schemaVersion: 1, machines: [machine] }).success).toBe(false)
  })
})

it("preserves temporarily invalid custom memory only in an unfinished editor", () => {
  const draft = { ...fixtureMachineDefaults[0], memoryGiB: 0, maxMemoryGiB: 12 }
  expect(machineEditorDraftSchema.safeParse({ draft, insertAt: 0 }).success).toBe(true)
  expect(setupMachineConfigurationRequestSchema.safeParse({ schemaVersion: 1, machines: [draft] }).success).toBe(false)
})

it("accepts custom CPUs and disks and rejects storage overflow", () => {
  const machine = { ...fixtureMachineDefaults[0], cpus: 3, maxCPUs: 5, memoryGiB: 12, maxMemoryGiB: 12, workspaceStorageGiB: 35, runtimeStorageGiB: 25 }
  const parse = (changes: object) => setupMachineConfigurationRequestSchema.safeParse({ schemaVersion: 1, machines: [{ ...machine, ...changes }] }).success
  expect(parse({})).toBe(true)
  for (const changes of [{ cpus: 0 }, { cpus: 1.5 }, { cpus: 6 }, { maxCPUs: 4294967296 }, { workspaceStorageGiB: 0 }, { runtimeStorageGiB: 1.5 }, { workspaceStorageGiB: 4194300, runtimeStorageGiB: 4 }]) {
    expect(parse(changes)).toBe(false)
  }
})
