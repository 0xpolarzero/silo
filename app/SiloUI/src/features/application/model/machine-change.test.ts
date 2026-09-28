import { describe, expect, it } from "vitest"

import { deriveMachineChange } from "./machine-change"
import type { SetupMachineConfiguration } from "@/contracts/silo"

function vm(id: string, name: string, overrides: Partial<SetupMachineConfiguration> = {}): SetupMachineConfiguration {
  return {
    kind: "vm",
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

describe("deriveMachineChange", () => {
  const a = vm("01", "dev")
  const b = vm("02", "web")

  it("classifies a create as an upsert with no expected", () => {
    const c = vm("03", "db")
    expect(deriveMachineChange([a, b], [a, b, c])).toEqual({ kind: "upsert", machine: c, expected: null })
  })

  it("classifies an edit as an upsert carrying the previous configuration", () => {
    const edited = vm("01", "dev", { cpus: 3 })
    expect(deriveMachineChange([a, b], [edited, b])).toEqual({ kind: "upsert", machine: edited, expected: a })
  })

  it("classifies a removal as a delete carrying the removed configuration", () => {
    expect(deriveMachineChange([a, b], [a])).toEqual({ kind: "delete", vmId: b.id, expected: b })
  })

  it("classifies a pure reorder", () => {
    expect(deriveMachineChange([a, b], [b, a])).toEqual({ kind: "reorder", order: [b.id, a.id], expectedOrder: [a.id, b.id] })
  })

  it("ignores field-order differences and returns null for a no-op", () => {
    const reordered = { name: "dev", kind: "vm" as const, id: a.id, maxCPUs: 4, cpus: 2, runtimeStorageGiB: 10, memoryGiB: 2, workspaceStorageGiB: 10, maxMemoryGiB: 4 }
    expect(deriveMachineChange([a, b], [reordered as SetupMachineConfiguration, b])).toBeNull()
  })

  it("returns null when more than one machine changed (not a single targeted operation)", () => {
    const editedA = vm("01", "dev", { cpus: 3 })
    const editedB = vm("02", "web", { cpus: 3 })
    expect(deriveMachineChange([a, b], [editedA, editedB])).toBeNull()
  })

  it("returns null when a removal also changes a surviving machine", () => {
    const editedA = vm("01", "dev", { cpus: 3 })
    expect(deriveMachineChange([a, b], [editedA])).toBeNull()
  })
})
