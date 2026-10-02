import { describe, expect, it, vi } from "vitest"
import { createDirectoryStore, directoryKey } from "@/features/application/model/directory-store"
import { remoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { applicationSourceForScenario } from "./application-scenarios"
import { fixtureDirectoryLoader } from "./directory-loader"

function fixture() {
  const workspace = applicationSourceForScenario("running").workspaces[0]
  return { workspace, loader: fixtureDirectoryLoader([workspace]) }
}

describe("native directory fixture behavior", () => {
  it.each(["stopped", "starting", "failed"] as const)("rejects files from a %s sandbox with the native string error", async state => {
    const { workspace, loader } = fixture()
    workspace.state = state
    await expect(loader(workspace.machine.name, "/workspace", 0)).rejects.toBe("Start this VM to browse its files.")
  })

  it("preserves the start instruction when a native read races with stopping", async () => {
    const { workspace, loader } = fixture()
    workspace.state = "stopped"
    const store = createDirectoryStore(loader)
    await store.load(workspace.machine.name, "/workspace")
    expect(store.getSnapshot(directoryKey(workspace.machine.name, "/workspace"))).toMatchObject({ entries: null, error: "Start this sandbox to browse its files." })
  })

  it.each(["/", "/workspace2", "/workspace/../etc", "/workspace//src", "/workspace/src/", "/workspace/./src"])("rejects the native-invalid path %s", async path => {
    const { workspace, loader } = fixture()
    await expect(loader(workspace.machine.name, path, 0)).rejects.toBe("Invalid folder request.")
  })

  it.each([-1, 1, 1.5, 201, 20_200])("rejects native-invalid pagination offset %s", async offset => {
    const { workspace, loader } = fixture()
    await expect(loader(workspace.machine.name, "/workspace", offset)).rejects.toBe("Invalid folder request.")
  })

  it("distinguishes a missing sandbox, missing folder, non-folder and empty folder", async () => {
    const { workspace, loader } = fixture()
    workspace.files = [{ name: "empty", kind: "folder" }, { name: "file.txt", kind: "file" }]
    await expect(loader("missing", "/workspace", 0)).rejects.toBe("Sandbox no longer exists.")
    await expect(loader(workspace.machine.name, "/workspace/missing", 0)).rejects.toBe("This folder no longer exists.")
    await expect(loader(workspace.machine.name, "/workspace/file.txt", 0)).rejects.toBe("This folder cannot be browsed.")
    expect(await loader(workspace.machine.name, "/workspace/empty", 0)).toMatchObject({ entries: [], nextOffset: null })
  })

  it("sorts folders first and names in native lexical order", async () => {
    const { workspace, loader } = fixture()
    workspace.files = [{ name: "z", kind: "folder" }, { name: "b", kind: "file" }, { name: "a", kind: "folder" }, { name: "A", kind: "file" }]
    expect((await loader(workspace.machine.name, "/workspace", 0)).entries.map(entry => entry.name)).toEqual(["a", "z", "A", "b"])
  })

  it("uses the qualified remote target when local and remote sandboxes share a name", async () => {
    const { workspace } = fixture()
    workspace.files = [{ name: "local", kind: "file" }]
    const remote = { ...workspace, computer: { id: "office", vmId: "remote-vm", name: "Office", address: "office.test", connected: true }, files: [{ name: "remote", kind: "file" as const }] }
    const loader = fixtureDirectoryLoader([workspace, remote])
    expect((await loader(remoteWorkspaceTarget("office", "remote-vm"), "/workspace", 0)).entries[0].name).toBe("remote")
  })

  it("pins pagination to a frozen, owner-bound scan and refreshes with a new identity", async () => {
    const { workspace, loader } = fixture()
    workspace.files = Array.from({ length: 401 }, (_, index) => ({ name: String(index).padStart(3, "0"), kind: "file" }))
    const first = await loader(workspace.machine.name, "/workspace", 0)
    workspace.files.unshift({ name: "000-new", kind: "file" })
    const older = await loader(workspace.machine.name, "/workspace", 200, first.snapshotId)
    expect(first.entries).toHaveLength(200)
    expect(first.nextOffset).toBe(200)
    expect(older.entries[0].name).toBe("200")
    expect(older.snapshotId).toBe(first.snapshotId)
    await expect(loader(workspace.machine.name, "/workspace", 200)).rejects.toBe("Folder listing expired. Refresh this folder.")
    await expect(loader(workspace.machine.name, "/workspace/other", 200, first.snapshotId)).rejects.toBe("Folder listing expired. Refresh this folder.")
    const refreshed = await loader(workspace.machine.name, "/workspace", 0)
    expect(refreshed.snapshotId).not.toBe(first.snapshotId)
    expect(refreshed.entries[1].name).toBe("000-new")
    expect((await loader(workspace.machine.name, "/workspace", 400, first.snapshotId)).entries).toHaveLength(1)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000)
    await expect(loader(workspace.machine.name, "/workspace", 200, first.snapshotId)).rejects.toBe("Folder listing expired. Refresh this folder.")
  })
})
