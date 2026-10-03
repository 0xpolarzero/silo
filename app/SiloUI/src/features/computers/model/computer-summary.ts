import type { SetupComputerConfiguration } from "@/contracts/silo"

export function computerSummary(configuration: SetupComputerConfiguration): string {
  return `CPUs: ${configuration.cpus} · Memory: ${configuration.memoryGiB} GiB · Disk: ${configuration.workspaceStorageGiB} GiB`
}
