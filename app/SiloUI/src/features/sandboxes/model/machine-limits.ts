import type { SetupVirtualMachineConfiguration } from "@/contracts/silo"
import type { MachineValidationErrors } from "@/features/onboarding/model/machine-configuration"

/**
 * What the runtime accepts for a sandbox's resources: CPU counts are stored as a `u8`,
 * memory as a `u32` of GiB, and the two disks share 4,194,303 GiB (`contracts/silo.ts`).
 */
export const runtimeLimits = {
  cpus: 255,
  memoryGiB: 4_294_967_295,
  storageGiB: 4_194_303,
} as const

type ResourceField = "cpus" | "maxCPUs" | "memoryGiB" | "maxMemoryGiB" | "workspaceStorageGiB" | "runtimeStorageGiB"
export const resourceFields: readonly ResourceField[] = ["cpus", "maxCPUs", "memoryGiB", "maxMemoryGiB", "workspaceStorageGiB", "runtimeStorageGiB"]

/** Reads a custom resource value typed by the user: only plain digits count ("1.5", "1e3" and "" do not). */
export function parseWholeNumber(text: string): number {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 0
}

function wholeNumberIn(value: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum
}

const number = (value: number) => value.toLocaleString("en-US")

/**
 * Readable range checks for a VM's resource fields. They replace the contract schema's
 * messages ("Too small: expected number to be >=1") for these fields.
 */
export function validateMachineResources(machine: SetupVirtualMachineConfiguration): MachineValidationErrors {
  const errors: MachineValidationErrors = {}
  const range = (field: ResourceField, maximum: number, unit: string) => {
    if (!wholeNumberIn(machine[field], maximum)) errors[field] = `Enter a whole number of ${unit} from 1 to ${number(maximum)}.`
  }
  range("cpus", runtimeLimits.cpus, "CPUs")
  range("maxCPUs", runtimeLimits.cpus, "CPUs")
  range("memoryGiB", runtimeLimits.memoryGiB, "GB")
  range("maxMemoryGiB", runtimeLimits.memoryGiB, "GB")
  range("workspaceStorageGiB", runtimeLimits.storageGiB, "GB")
  range("runtimeStorageGiB", runtimeLimits.storageGiB, "GB")
  if (!errors.cpus && !errors.maxCPUs && machine.cpus > machine.maxCPUs) errors.cpus = "CPU limit cannot exceed its ceiling."
  if (!errors.memoryGiB && !errors.maxMemoryGiB && machine.memoryGiB > machine.maxMemoryGiB) errors.memoryGiB = "Memory limit cannot exceed its ceiling."
  if (!errors.workspaceStorageGiB && !errors.runtimeStorageGiB && machine.workspaceStorageGiB + machine.runtimeStorageGiB > runtimeLimits.storageGiB) {
    errors.workspaceStorageGiB = `Workspace and runtime storage together can't exceed ${number(runtimeLimits.storageGiB)} GB.`
  }
  return errors
}
