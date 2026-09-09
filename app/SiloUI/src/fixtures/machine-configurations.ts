import type { SetupVirtualMachineConfiguration } from "@/contracts/silo"

// Multiple machines for previews and interaction tests only.
export const fixtureMachineDefaults: readonly SetupVirtualMachineConfiguration[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "vm",
    name: "dev",
    cpus: 8,
    maxCPUs: 12,
    memoryGiB: 32,
    maxMemoryGiB: 48,
    workspaceStorageGiB: 120,
    runtimeStorageGiB: 100,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    kind: "vm",
    name: "playgrounds",
    cpus: 4,
    maxCPUs: 12,
    memoryGiB: 32,
    maxMemoryGiB: 48,
    workspaceStorageGiB: 60,
    runtimeStorageGiB: 60,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    kind: "vm",
    name: "personal",
    cpus: 6,
    maxCPUs: 12,
    memoryGiB: 16,
    maxMemoryGiB: 32,
    workspaceStorageGiB: 100,
    runtimeStorageGiB: 80,
  },
] as const

