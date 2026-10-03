/** The title of every Delete computer confirmation (decision 6). */
export function deleteComputerTitle(displayName: string): string {
  return `Delete ${displayName} permanently?`
}

/** The consequence line shown by every Delete computer confirmation (row, row menu and page).
 * Deleting a computer removes its workspace disk and checkpoint history. */
export function deleteComputerDescription(checkpoints?: number, size?: string): string {
  const history = checkpoints === undefined ? "checkpoints" : checkpoints === 1 ? "1 checkpoint" : `${checkpoints} checkpoints`
  return `Its files${size ? ` (${size})` : ""} and ${history} will be deleted. This can't be undone.`
}

/** A computer's size on disk, as the storage and resource settings show sizes. */
export function formatComputerSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(1)} GiB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`
}
