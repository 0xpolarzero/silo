import { describe, expect, it } from "vitest"

import { productionMachineDefaults, supportedCPUs, supportedMemoryGiB } from "@/features/onboarding/model/machine-configuration"
import { fitMachineToCapacity, presetsWithin, validateMachineResources } from "./machine-limits"

const template = productionMachineDefaults[0]!
const small = { logicalCPUs: 8, memoryGiB: 16 }

describe("sandbox resource limits", () => {
  it("fits new-sandbox defaults to a small computer", () => {
    // 8/12 CPUs and 32/48 GB would be rejected on an 8-core, 16 GB Mac.
    expect(fitMachineToCapacity(template, small)).toMatchObject({ cpus: 4, maxCPUs: 8, memoryGiB: 8, maxMemoryGiB: 16 })
    expect(validateMachineResources(fitMachineToCapacity(template, small), small)).toEqual({})
  })

  it("keeps the defaults on a computer that can run them, and without a known capacity", () => {
    const large = { logicalCPUs: 16, memoryGiB: 64 }
    expect(fitMachineToCapacity(template, large)).toEqual(template)
    expect(fitMachineToCapacity(template, undefined)).toEqual(template)
  })

  it("offers only presets the computer can run, plus its own maximum", () => {
    expect(presetsWithin(supportedCPUs, 10)).toEqual([1, 2, 4, 6, 8, 10])
    expect(presetsWithin(supportedMemoryGiB, 16)).toEqual([1, 2, 4, 8, 12, 16])
    expect(presetsWithin(supportedCPUs, undefined)).toEqual(supportedCPUs)
  })

  it("rejects ceilings above the computer in words that name it", () => {
    const machine = { ...template, cpus: 4, maxCPUs: 12, memoryGiB: 8, maxMemoryGiB: 48 }
    expect(validateMachineResources(machine, small)).toEqual({
      maxCPUs: "This computer has 8 CPUs. Choose 8 or fewer.",
      maxMemoryGiB: "This computer has 16 GB of memory. Choose 16 GB or fewer.",
    })
    expect(validateMachineResources(machine, small, "office-mac").maxCPUs).toBe("office-mac has 8 CPUs. Choose 8 or fewer.")
    // Without a known capacity only the runtime's own limits apply.
    expect(validateMachineResources(machine)).toEqual({})
  })
})
