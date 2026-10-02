import { describe, expect, it } from "vitest"
import { configurationRequest, machineCapacityError, productionMachineDefaults, validateMachine } from "./machine-configuration"

describe("machine validation errors", () => {
  it("reports configuration fields this version cannot submit as a form error", () => {
    const machine = { ...productionMachineDefaults[0], futurePolicy: { enabled: true } }
    expect(() => configurationRequest([machine])).toThrow()
    expect(validateMachine(machine, [machine], machine.id).form).toBeTruthy()
  })

  it("reports invalid IDs through the form rather than an undisplayed field", () => {
    const machine = { ...productionMachineDefaults[0], id: "not-a-uuid" }
    expect(validateMachine(machine, [machine], machine.id).form).toBeTruthy()
    expect(validateMachine(machine, [machine], machine.id)).not.toHaveProperty("id")
  })
})

describe("machine capacity", () => {
  it("allows a new sandbox in the last slot and rejects additions at or beyond 64", () => {
    expect(machineCapacityError(63)).toBeUndefined()
    expect(machineCapacityError(64)).toBe("Configure no more than 64 sandboxes.")
    expect(machineCapacityError(65)).toBe("Configure no more than 64 sandboxes.")
  })

  it("allows editing an existing sandbox without consuming another slot", () => {
    expect(machineCapacityError(64, productionMachineDefaults[0].id)).toBeUndefined()
    expect(machineCapacityError(65, productionMachineDefaults[0].id)).toBeUndefined()
  })

  it("accepts 64 machines at the configuration boundary and rejects a 65th", () => {
    const machines = Array.from({ length: 65 }, (_, index) => ({
      ...productionMachineDefaults[0],
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `machine-${index + 1}`,
    }))
    expect(configurationRequest(machines.slice(0, 64)).machines).toHaveLength(64)
    expect(() => configurationRequest(machines)).toThrow()
  })
})
