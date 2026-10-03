import type { ApplicationWorkspace } from "@/features/application/model/application-source"

/** The most rows a saved order keeps; matches the `sandboxOrder` setting's limit. */
export const sandboxOrderLimit = 1024

/**
 * A row's key in this device's saved sandbox order. Local sandboxes use their stable id, so a
 * rename keeps their place; remote ones use their device and that device's sandbox id.
 */
export function sandboxOrderKey(workspace: Pick<ApplicationWorkspace, "machine" | "device">): string {
  return workspace.device ? `remote:${workspace.device.id}:${workspace.device.vmId}` : `local:${workspace.machine.id}`
}

/** Each saved key's position, for `MachineList`'s `orderRank`. */
export function sandboxOrderRanks(order: readonly string[]): Map<string, number> {
  return new Map(order.map((key, index) => [key, index]))
}

/**
 * The order to save after a reorder: the rows as now shown, then the saved keys of rows not
 * shown (a device that is offline or not loaded yet), so they keep their place for later.
 */
export function nextSandboxOrder(saved: readonly string[], shown: readonly string[]): string[] {
  const visible = new Set(shown)
  return [...shown, ...saved.filter(key => !visible.has(key))].slice(0, sandboxOrderLimit)
}
