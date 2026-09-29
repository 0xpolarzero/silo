/** The consequence line shown by every Delete sandbox confirmation (row, row menu and page).
 * Deleting a VM removes its workspace disk and checkpoint history; an SSH sandbox is only a
 * saved connection, so nothing on its host changes. */
export function deleteSandboxDescription(kind: string, checkpoints?: number): string {
  if (kind !== "vm") return "Removes this SSH connection from Silo. Nothing on the host is deleted."
  const history = checkpoints === undefined ? "checkpoints" : checkpoints === 1 ? "1 checkpoint" : `${checkpoints} checkpoints`
  return `Its files and ${history} will be deleted. This can't be undone.`
}
