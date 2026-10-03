import { describe, expect, it } from "vitest"
import { configurationRequest, computerCapacityError, productionComputerDefaults, validateComputer } from "./computer-configuration"

describe("configuration validation errors", () => {
  it("reports configuration fields this version cannot submit as a form error", () => {
    const configuration = { ...productionComputerDefaults[0], futurePolicy: { enabled: true } }
    expect(() => configurationRequest([configuration])).toThrow()
    expect(validateComputer(configuration, [configuration], configuration.id).form).toBeTruthy()
  })

  it("reports invalid IDs through the form rather than an undisplayed field", () => {
    const configuration = { ...productionComputerDefaults[0], id: "not-a-uuid" }
    expect(validateComputer(configuration, [configuration], configuration.id).form).toBeTruthy()
    expect(validateComputer(configuration, [configuration], configuration.id)).not.toHaveProperty("id")
  })
})

describe("configuration capacity", () => {
  it("allows a new computer in the last slot and rejects additions at or beyond 64", () => {
    expect(computerCapacityError(63)).toBeUndefined()
    expect(computerCapacityError(64)).toBe("Configure no more than 64 computers.")
    expect(computerCapacityError(65)).toBe("Configure no more than 64 computers.")
  })

  it("allows editing an existing computer without consuming another slot", () => {
    expect(computerCapacityError(64, productionComputerDefaults[0].id)).toBeUndefined()
    expect(computerCapacityError(65, productionComputerDefaults[0].id)).toBeUndefined()
  })

  it("accepts 64 configurations at the configuration boundary and rejects a 65th", () => {
    const configurations = Array.from({ length: 65 }, (_, index) => ({
      ...productionComputerDefaults[0],
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `computer-${index + 1}`,
    }))
    expect(configurationRequest(configurations.slice(0, 64)).configurations).toHaveLength(64)
    expect(() => configurationRequest(configurations)).toThrow()
  })
})
