import type { SetupMachineConfiguration } from "@/contracts/silo"

export function machineSummary(machine: SetupMachineConfiguration): string {
  return `CPUs: ${machine.cpus} · Memory: ${machine.memoryGiB} GiB · Disk: ${machine.workspaceStorageGiB} GiB`
}
