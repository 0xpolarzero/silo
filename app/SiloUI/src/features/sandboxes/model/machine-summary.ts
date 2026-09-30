import type { SetupMachineConfiguration } from "@/contracts/silo"

export function machineSummary(machine: SetupMachineConfiguration): string {
  if (machine.kind === "ssh") return `${machine.user}@${machine.host}:${machine.port}`
  return `CPUs: ${machine.cpus} · Memory: ${machine.memoryGiB} GiB · Disk: ${machine.workspaceStorageGiB} GiB`
}
