/** The title of every Delete sandbox confirmation (decision 6). */
export function deleteSandboxTitle(displayName: string): string {
  return `Delete ${displayName} permanently?`
}

/** The consequence line shown by every Delete sandbox confirmation (row, row menu and page).
 * Deleting a VM removes its workspace disk and checkpoint history; an SSH sandbox is only a
 * saved connection, so nothing on its host changes. */
export function deleteSandboxDescription(kind: string, checkpoints?: number, size?: string): string {
  if (kind !== "vm") return "Removes this SSH connection from Silo. Nothing on the host is deleted."
  const history = checkpoints === undefined ? "checkpoints" : checkpoints === 1 ? "1 checkpoint" : `${checkpoints} checkpoints`
  return `Its files${size ? ` (${size})` : ""} and ${history} will be deleted. This can't be undone.`
}

/** A sandbox's size on disk, as the storage and resource settings show sizes. */
export function formatSandboxSize(bytes: number): string {
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(1)} GiB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`
}
