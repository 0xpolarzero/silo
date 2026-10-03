import type { ApplicationComputer } from "@/features/application/model/application-source"

/** The most rows a saved order keeps; matches the `computerOrder` setting's limit. */
export const computerOrderLimit = 1024

/**
 * A row's key in this device's saved computer order. Local computers use their stable id, so a
 * rename keeps their place; remote ones use their device and that device's computer id.
 */
export function computerOrderKey(computer: Pick<ApplicationComputer, "configuration" | "device">): string {
  return computer.device ? `remote:${computer.device.id}:${computer.device.computerId}` : `local:${computer.configuration.id}`
}

/** Each saved key's position, for `ComputerConfigurationList`'s `orderRank`. */
export function computerOrderRanks(order: readonly string[]): Map<string, number> {
  return new Map(order.map((key, index) => [key, index]))
}

/**
 * The order to save after a reorder: the rows as now shown, then the saved keys of rows not
 * shown (a device that is offline or not loaded yet), so they keep their place for later.
 */
export function nextComputerOrder(saved: readonly string[], shown: readonly string[]): string[] {
  const visible = new Set(shown)
  return [...shown, ...saved.filter(key => !visible.has(key))].slice(0, computerOrderLimit)
}
