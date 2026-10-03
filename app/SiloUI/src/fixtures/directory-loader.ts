import type { ApplicationWorkspace } from "@/features/application/model/application-source"
import type { DirectoryLoader } from "@/features/application/model/directory-store"
import { workspaceTarget } from "@/features/application/model/connections"

/** Static directory data belongs only to previews and tests. */
export function fixtureDirectoryLoader(workspaces: ApplicationWorkspace[]): DirectoryLoader {
  const snapshots = new Map<string, { workspace: string; path: string; created: number; entries: { name: string; path: string; kind: "folder" | "file" }[] }>()
  let nextSnapshot = 0
  return async (workspace, path, offset, snapshotId) => {
    const parts = path.slice("/workspace/".length).split("/")
    if (new TextEncoder().encode(path).length > 4096 || path.includes("\0") || (path !== "/workspace" && (!path.startsWith("/workspace/") || parts.some(part => !part || part === "." || part === ".."))) || !Number.isInteger(offset) || offset < 0 || offset > 20_000 || offset % 200 !== 0) throw "Invalid folder request."
    const owner = workspaces.find(item => workspaceTarget(item) === workspace)
    if (!owner) throw "Sandbox no longer exists."
    if (owner.state !== "running") throw "Start this VM to browse its files."
    let snapshot = snapshotId ? snapshots.get(snapshotId) : undefined
    if (offset) {
      if (!snapshot || snapshot.workspace !== workspace || snapshot.path !== path || Date.now() - snapshot.created >= 120_000 || offset > snapshot.entries.length) throw "Folder listing expired. Refresh this folder."
    } else {
      let files = owner.files
      for (const name of path === "/workspace" ? [] : parts) {
        const entry = files.find(entry => entry.name === name)
        if (!entry) throw "This folder no longer exists."
        if (entry.kind !== "folder") throw "This folder cannot be browsed."
        files = entry.children ?? []
      }
      if (files.length > 20_000 || files.reduce((sum, entry) => sum + new TextEncoder().encode(entry.name).length * 2 + new TextEncoder().encode(path).length + 96, 0) > 2 * 1024 * 1024) throw "This folder is too large to list."
      const entries = files.map(entry => ({ name: entry.name, path: `${path}/${entry.name}`, kind: entry.kind }))
        .sort((a, b) => Number(a.kind !== "folder") - Number(b.kind !== "folder") || (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))
      snapshotId = String(++nextSnapshot)
      snapshot = { workspace, path, created: Date.now(), entries }
      for (const [id, cached] of snapshots) if (Date.now() - cached.created >= 120_000) snapshots.delete(id)
      if (snapshots.size >= 64) snapshots.delete(snapshots.keys().next().value!)
      snapshots.set(snapshotId, snapshot)
    }
    return {
      snapshotId: snapshotId!,
      entries: snapshot!.entries.slice(offset, offset + 200).map(entry => ({ ...entry })),
      nextOffset: snapshot!.entries.length > offset + 200 ? offset + 200 : null,
    }
  }
}
