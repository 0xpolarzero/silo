import type { ApplicationWorkspace } from "@/features/application/model/application-source"
import type { DirectoryLoader } from "@/features/application/model/directory-store"

/** Static directory data belongs only to previews and tests. */
export function fixtureDirectoryLoader(workspaces: ApplicationWorkspace[]): DirectoryLoader {
  return async (workspace, path, offset) => {
    let entries = workspaces.find(({ machine }) => machine.name === workspace)?.files ?? []
    for (const name of path.slice("/workspace".length).split("/").filter(Boolean)) {
      entries = entries.find((entry) => entry.name === name)?.children ?? []
    }
    return {
      snapshotId: `fixture:${workspace}:${path}`,
      entries: entries.slice(offset, offset + 200).map((entry) => ({ name: entry.name, path: `${path}/${entry.name}`, kind: entry.kind })),
      nextOffset: entries.length > offset + 200 ? offset + 200 : null,
    }
  }
}
