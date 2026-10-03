import { describe, expect, it } from "vitest"

import { deriveComputerChanges } from "./computer-change"
import type { SetupComputerConfiguration } from "@/contracts/silo"

function vm(id: string, name: string, overrides: Partial<SetupComputerConfiguration> = {}): SetupComputerConfiguration {
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
  } as SetupComputerConfiguration
}

describe("deriveComputerChanges", () => {
  const a = vm("01", "dev")
  const b = vm("02", "web")

  it("classifies a create as a single upsert with no expected", () => {
    const c = vm("03", "db")
    expect(deriveComputerChanges([a, b], [a, b, c])).toEqual([{ kind: "upsert", configuration: c, expected: null }])
  })

  it("classifies an edit as a single upsert carrying the previous configuration", () => {
    const edited = vm("01", "dev", { cpus: 3 })
    expect(deriveComputerChanges([a, b], [edited, b])).toEqual([{ kind: "upsert", configuration: edited, expected: a }])
  })

  it("classifies a removal as a single delete carrying the removed configuration", () => {
    expect(deriveComputerChanges([a, b], [a])).toEqual([{ kind: "delete", computerId: b.id, expected: b }])
  })

  it("classifies a pure reorder", () => {
    expect(deriveComputerChanges([a, b], [b, a])).toEqual([{ kind: "reorder", order: [b.id, a.id], expectedOrder: [a.id, b.id] }])
  })

  it("ignores field-order differences and returns an empty list for a no-op", () => {
    const reordered = { name: "dev", id: a.id, maxCPUs: 4, cpus: 2, runtimeStorageGiB: 10, memoryGiB: 2, workspaceStorageGiB: 10, maxMemoryGiB: 4 }
    expect(deriveComputerChanges([a, b], [reordered as SetupComputerConfiguration, b])).toEqual([])
  })

  it("returns a batch of creates for the initial setup of several computers", () => {
    const c = vm("03", "db")
    expect(deriveComputerChanges([], [a, b, c])).toEqual([
      { kind: "upsert", configuration: a, expected: null },
      { kind: "upsert", configuration: b, expected: null },
      { kind: "upsert", configuration: c, expected: null },
    ])
  })

  it("returns one upsert per configuration when several change at once", () => {
    const editedA = vm("01", "dev", { cpus: 3 })
    const editedB = vm("02", "web", { cpus: 3 })
    expect(deriveComputerChanges([a, b], [editedA, editedB])).toEqual([
      { kind: "upsert", configuration: editedA, expected: a },
      { kind: "upsert", configuration: editedB, expected: b },
    ])
  })

  it("combines a removal with an edit to a surviving configuration (delete before upsert)", () => {
    const editedA = vm("01", "dev", { cpus: 3 })
    expect(deriveComputerChanges([a, b], [editedA])).toEqual([
      { kind: "delete", computerId: b.id, expected: b },
      { kind: "upsert", configuration: editedA, expected: a },
    ])
  })
})
