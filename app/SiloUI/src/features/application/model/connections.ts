import { z } from "zod"
import type { ApplicationWorkspace } from "./application-source"

export const deviceSchema = z.object({ id: z.string().min(1), name: z.string().min(1), address: z.string().min(1) })
export const connectionsStatusSchema = z.object({ enabled: z.boolean(), deviceId: z.string(), name: z.string(), address: z.string(), addresses: z.array(z.object({ address: z.string().min(1), kind: z.enum(["name", "tailscale", "network"]) })).optional(), error: z.string().nullish() })
export type Device = z.infer<typeof deviceSchema> & { connected: boolean; busy?: boolean; error?: string; lastSeen?: number }
export type ConnectionsStatus = z.infer<typeof connectionsStatusSchema>
export type WorkspaceDevice = Device & { vmId: string }

export function remoteWorkspaceTarget(deviceId: string, vmId: string): string {
  return `silo-remote:${encodeURIComponent(deviceId)}:${encodeURIComponent(vmId)}`
}
export function parseRemoteWorkspaceTarget(target: string): { deviceId: string; vmId: string } | undefined {
  if (!target.startsWith("silo-remote:")) return undefined
  const parts = target.split(":")
  if (parts.length !== 3 || !parts[1] || !parts[2]) throw new Error("Silo could not identify the remote sandbox. Refresh its device and retry.")
  return { deviceId: decodeURIComponent(parts[1]), vmId: decodeURIComponent(parts[2]) }
}
export function workspaceTarget(workspace: ApplicationWorkspace): string {
  return workspace.device ? remoteWorkspaceTarget(workspace.device.id, workspace.device.vmId) : workspace.machine.name
}
