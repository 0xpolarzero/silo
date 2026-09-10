import { z } from "zod"
import type { ApplicationWorkspace } from "./application-source"

export const remoteComputerSchema = z.object({ id: z.string().min(1), name: z.string().min(1), address: z.string().min(1) })
export const remoteManagementSchema = z.object({ enabled: z.boolean(), hostId: z.string(), name: z.string(), address: z.string() })
export type RemoteComputer = z.infer<typeof remoteComputerSchema> & { connected: boolean; busy?: boolean; error?: string; lastSeen?: number }
export type RemoteManagement = z.infer<typeof remoteManagementSchema>
export type WorkspaceComputer = RemoteComputer & { vmId: string }

export function remoteWorkspaceTarget(hostId: string, vmId: string): string {
  return `silo-remote:${encodeURIComponent(hostId)}:${encodeURIComponent(vmId)}`
}
export function parseRemoteWorkspaceTarget(target: string): { hostId: string; vmId: string } | undefined {
  if (!target.startsWith("silo-remote:")) return undefined
  const parts = target.split(":")
  if (parts.length !== 3 || !parts[1] || !parts[2]) throw new Error("Invalid remote VM target.")
  return { hostId: decodeURIComponent(parts[1]), vmId: decodeURIComponent(parts[2]) }
}
export function workspaceTarget(workspace: ApplicationWorkspace): string {
  return workspace.computer ? remoteWorkspaceTarget(workspace.computer.id, workspace.computer.vmId) : workspace.machine.name
}
