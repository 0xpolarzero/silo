import { describe, expect, it, vi } from "vitest"
import { createDirectoryStore, directoryKey } from "@/features/application/model/directory-store"
import { remoteComputerTarget } from "@/features/application/model/connections"
import { applicationSourceForScenario } from "./application-scenarios"
import { fixtureDirectoryLoader } from "./directory-loader"

function fixture() {
  const computer = applicationSourceForScenario("running").computers[0]
  return { computer, loader: fixtureDirectoryLoader([computer]) }
}

describe("native directory fixture behavior", () => {
  it.each(["stopped", "starting", "failed"] as const)("rejects files from a %s computer with the native string error", async state => {
    const { computer, loader } = fixture()
    computer.state = state
    await expect(loader(computer.configuration.name, "/workspace", 0)).rejects.toBe("Start this computer to browse its files.")
  })

  it("preserves the start instruction when a native read races with stopping", async () => {
    const { computer, loader } = fixture()
    computer.state = "stopped"
    const store = createDirectoryStore(loader)
    await store.load(computer.configuration.name, "/workspace")
    expect(store.getSnapshot(directoryKey(computer.configuration.name, "/workspace"))).toMatchObject({ entries: null, error: "Start this computer to browse its files." })
  })

  it.each(["/", "/computer2", "/workspace/../etc", "/workspace//src", "/workspace/src/", "/workspace/./src"])("rejects the native-invalid path %s", async path => {
    const { computer, loader } = fixture()
    await expect(loader(computer.configuration.name, path, 0)).rejects.toBe("Invalid folder request.")
  })

  it.each([-1, 1, 1.5, 201, 20_200])("rejects native-invalid pagination offset %s", async offset => {
    const { computer, loader } = fixture()
    await expect(loader(computer.configuration.name, "/workspace", offset)).rejects.toBe("Invalid folder request.")
  })

  it("distinguishes a missing computer, missing folder, non-folder and empty folder", async () => {
    const { computer, loader } = fixture()
    computer.files = [{ name: "empty", kind: "folder" }, { name: "file.txt", kind: "file" }]
    await expect(loader("missing", "/workspace", 0)).rejects.toBe("Computer no longer exists.")
    await expect(loader(computer.configuration.name, "/workspace/missing", 0)).rejects.toBe("This folder no longer exists.")
    await expect(loader(computer.configuration.name, "/workspace/file.txt", 0)).rejects.toBe("This folder cannot be browsed.")
    expect(await loader(computer.configuration.name, "/workspace/empty", 0)).toMatchObject({ entries: [], nextOffset: null })
  })

  it("sorts folders first and names in native lexical order", async () => {
    const { computer, loader } = fixture()
    computer.files = [{ name: "z", kind: "folder" }, { name: "b", kind: "file" }, { name: "a", kind: "folder" }, { name: "A", kind: "file" }]
    expect((await loader(computer.configuration.name, "/workspace", 0)).entries.map(entry => entry.name)).toEqual(["a", "z", "A", "b"])
  })

  it("uses the qualified remote target when local and remote computers share a name", async () => {
    const { computer } = fixture()
    computer.files = [{ name: "local", kind: "file" }]
    const remote = { ...computer, device: { id: "office", computerId: "remote-computer", name: "Office", address: "office.test", connected: true }, files: [{ name: "remote", kind: "file" as const }] }
    const loader = fixtureDirectoryLoader([computer, remote])
    expect((await loader(remoteComputerTarget("office", "remote-computer"), "/workspace", 0)).entries[0].name).toBe("remote")
  })

  it("pins pagination to a frozen, owner-bound scan and refreshes with a new identity", async () => {
    const { computer, loader } = fixture()
    computer.files = Array.from({ length: 401 }, (_, index) => ({ name: String(index).padStart(3, "0"), kind: "file" }))
    const first = await loader(computer.configuration.name, "/workspace", 0)
    computer.files.unshift({ name: "000-new", kind: "file" })
    const older = await loader(computer.configuration.name, "/workspace", 200, first.snapshotId)
    expect(first.entries).toHaveLength(200)
    expect(first.nextOffset).toBe(200)
    expect(older.entries[0].name).toBe("200")
    expect(older.snapshotId).toBe(first.snapshotId)
    await expect(loader(computer.configuration.name, "/workspace", 200)).rejects.toBe("Folder listing expired. Refresh this folder.")
    await expect(loader(computer.configuration.name, "/workspace/other", 200, first.snapshotId)).rejects.toBe("Folder listing expired. Refresh this folder.")
    const refreshed = await loader(computer.configuration.name, "/workspace", 0)
    expect(refreshed.snapshotId).not.toBe(first.snapshotId)
    expect(refreshed.entries[1].name).toBe("000-new")
    expect((await loader(computer.configuration.name, "/workspace", 400, first.snapshotId)).entries).toHaveLength(1)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000)
    await expect(loader(computer.configuration.name, "/workspace", 200, first.snapshotId)).rejects.toBe("Folder listing expired. Refresh this folder.")
  })
})
