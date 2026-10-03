import { describe, expect, it } from "vitest"

import { deriveMachineChanges } from "./machine-change"
import type { SetupMachineConfiguration } from "@/contracts/silo"

function vm(id: string, name: string, overrides: Partial<SetupMachineConfiguration> = {}): SetupMachineConfiguration {
  return {
    id: `00000000-0000-4000-8000-0000000000${id}`,
    name,
    cpus: 2,
    maxCPUs: 4,
    memoryGiB: 2,
    maxMemoryGiB: 4,
    workspaceStorageGiB: 10,
    runtimeStorageGiB: 10,
    ...overrides,
  } as SetupMachineConfiguration
}

describe("deriveMachineChanges", () => {
  const a = vm("01", "dev")
  const b = vm("02", "web")

  it("classifies a create as a single upsert with no expected", () => {
    const c = vm("03", "db")
    expect(deriveMachineChanges([a, b], [a, b, c])).toEqual([{ kind: "upsert", machine: c, expected: null }])
  })

  it("classifies an edit as a single upsert carrying the previous configuration", () => {
    const edited = vm("01", "dev", { cpus: 3 })
    expect(deriveMachineChanges([a, b], [edited, b])).toEqual([{ kind: "upsert", machine: edited, expected: a }])
  })

  it("classifies a removal as a single delete carrying the removed configuration", () => {
    expect(deriveMachineChanges([a, b], [a])).toEqual([{ kind: "delete", vmId: b.id, expected: b }])
  })

  it("classifies a pure reorder", () => {
    expect(deriveMachineChanges([a, b], [b, a])).toEqual([{ kind: "reorder", order: [b.id, a.id], expectedOrder: [a.id, b.id] }])
  })

  it("ignores field-order differences and returns an empty list for a no-op", () => {
    const reordered = { name: "dev", id: a.id, maxCPUs: 4, cpus: 2, runtimeStorageGiB: 10, memoryGiB: 2, workspaceStorageGiB: 10, maxMemoryGiB: 4 }
    expect(deriveMachineChanges([a, b], [reordered as SetupMachineConfiguration, b])).toEqual([])
  })

  it("returns a batch of creates for the initial setup of several sandboxes", () => {
    const c = vm("03", "db")
    expect(deriveMachineChanges([], [a, b, c])).toEqual([
      { kind: "upsert", machine: a, expected: null },
      { kind: "upsert", machine: b, expected: null },
      { kind: "upsert", machine: c, expected: null },
    ])
  })

  it("returns one upsert per machine when several change at once", () => {
    const editedA = vm("01", "dev", { cpus: 3 })
    const editedB = vm("02", "web", { cpus: 3 })
    expect(deriveMachineChanges([a, b], [editedA, editedB])).toEqual([
      { kind: "upsert", machine: editedA, expected: a },
      { kind: "upsert", machine: editedB, expected: b },
    ])
  })

  it("combines a removal with an edit to a surviving machine (delete before upsert)", () => {
    const editedA = vm("01", "dev", { cpus: 3 })
    expect(deriveMachineChanges([a, b], [editedA])).toEqual([
      { kind: "delete", vmId: b.id, expected: b },
      { kind: "upsert", machine: editedA, expected: a },
    ])
  })
})
