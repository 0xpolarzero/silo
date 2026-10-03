import { describe, expect, it } from "vitest"

import { productionComputerDefaults, supportedCPUs, supportedMemoryGiB } from "@/features/onboarding/model/computer-configuration"
import { fitComputerToCapacity, deviceCapacityFrom, presetsWithin, validateComputerResources } from "./computer-limits"

const template = productionComputerDefaults[0]!
const small = { logicalCPUs: 8, memoryGiB: 16 }

describe("computer resource limits", () => {
  it("fits new-computer defaults to a small device", () => {
    // 8/12 CPUs and 32/48 GiB would be rejected on an 8-core, 16 GiB Mac.
    expect(fitComputerToCapacity(template, small)).toMatchObject({ cpus: 4, maxCPUs: 8, memoryGiB: 8, maxMemoryGiB: 16 })
    expect(validateComputerResources(fitComputerToCapacity(template, small), small)).toEqual({})
  })

  it("keeps the defaults on a device that can run them, and without a known capacity", () => {
    const large = { logicalCPUs: 16, memoryGiB: 64 }
    expect(fitComputerToCapacity(template, large)).toEqual(template)
    expect(fitComputerToCapacity(template, undefined)).toEqual(template)
  })

  it("offers only presets the device can run, plus its own maximum", () => {
    expect(presetsWithin(supportedCPUs, 10)).toEqual([1, 2, 4, 6, 8, 10])
    expect(presetsWithin(supportedMemoryGiB, 16)).toEqual([1, 2, 4, 8, 12, 16])
    expect(presetsWithin(supportedCPUs, undefined)).toEqual(supportedCPUs)
  })

  it("reads the capacity the application state reports and ignores anything malformed", () => {
    expect(deviceCapacityFrom({ logicalCpus: 8, physicalMemoryBytes: 17179869184, maxMemoryGib: 16 })).toEqual(small)
    for (const reported of [undefined, null, "8", { logicalCpus: 0, maxMemoryGib: 16 }, { logicalCpus: 8 }, { logicalCpus: 8.5, maxMemoryGib: 16 }]) {
      expect(deviceCapacityFrom(reported)).toBeUndefined()
    }
  })

  it("rejects ceilings above the device in words that name it", () => {
    const configuration = { ...template, cpus: 4, maxCPUs: 12, memoryGiB: 8, maxMemoryGiB: 48 }
    expect(validateComputerResources(configuration, small)).toEqual({
      maxCPUs: "This device has 8 CPUs. Choose 8 or fewer.",
      maxMemoryGiB: "This device has 16 GiB of memory. Choose 16 GiB or fewer.",
    })
    expect(validateComputerResources(configuration, small, "office-mac").maxCPUs).toBe("office-mac has 8 CPUs. Choose 8 or fewer.")
    // Without a known capacity only the runtime's own limits apply.
    expect(validateComputerResources(configuration)).toEqual({})
  })
})
