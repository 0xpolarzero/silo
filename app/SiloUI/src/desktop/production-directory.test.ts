import { describe, expect, it, vi } from "vitest"
import { createDirectoryStore, directoryKey } from "@/features/application/model/directory-store"
import { createProductionSource, type ProductionBridge } from "./production-source"

const entry = (name: string) => ({ name, path: `/workspace/${name}`, kind: "file" as const })
const page = (names: string[], nextOffset: number | null = null) => ({ snapshotId: "snapshot", entries: names.map(entry), nextOffset })

describe("production directory replies", () => {
  it.each([
    ["missing snapshot identity", { ...page(["invalid"]), snapshotId: "" }],
    ["fractional pagination offset", page(["invalid"], 1.5)],
    ["oversized page", page(Array.from({ length: 201 }, (_, index) => `invalid-${index}`))],
    ["private entry fields", { ...page(["invalid"]), entries: [{ ...entry("invalid"), secret: "private-backend-data" }] }],
  ])("retains cached files after a %s and accepts a valid retry", async (_description, malformed) => {
    const invoke = vi.fn().mockResolvedValueOnce(page(["cached"], 1))
      .mockResolvedValueOnce(malformed).mockResolvedValueOnce(page(["older"]))
    const production = createProductionSource({ invoke, listen: vi.fn() } as unknown as ProductionBridge)
    const store = createDirectoryStore(production.applicationActions.listComputerDirectory)
    const computer = "silo-remote:office:dev"
    const path = "/workspace"
    const key = directoryKey(computer, path)
    try {
      await store.load(computer, path)
      await store.load(computer, path, { more: true })

      expect(store.getSnapshot(key)).toMatchObject({
        entries: [entry("cached")], snapshotId: "snapshot", nextOffset: 1,
        loading: false, loadingMore: false, errorOperation: "more", error: "Could not load this folder.",
      })
      expect(JSON.stringify(store.getSnapshot(key))).not.toContain("private-backend-data")

      await store.load(computer, path, { more: true })

      expect(store.getSnapshot(key)).toMatchObject({ entries: [entry("cached"), entry("older")], nextOffset: null, error: null })
      expect(invoke.mock.calls).toEqual([
        ["list_computer_directory", { computer, path, offset: 0, snapshotId: null }],
        ["list_computer_directory", { computer, path, offset: 1, snapshotId: "snapshot" }],
        ["list_computer_directory", { computer, path, offset: 1, snapshotId: "snapshot" }],
      ])
    } finally { store.dispose(); production.dispose() }
  })
})
