import { expect, it, vi } from "vitest"
import { createProductionSource, type ProductionBridge } from "./production-source"

const storage = { history: [], workspaceHostBytes: 1000, runtimeHostBytes: 500, workspaceUsedBytes: null, workspaceCapacityBytes: null, lastReclaimedBytes: null, lastTrimAt: null, lastError: null }

it("uses the managed ID and validates measured storage responses at the native boundary", async () => {
  const invoke = vi.fn().mockResolvedValueOnce(storage).mockResolvedValueOnce({ ...storage, workspaceHostBytes: 700, lastReclaimedBytes: 300 }).mockResolvedValueOnce({ ...storage, workspaceHostBytes: -1 })
  const store = createProductionSource({ invoke, listen: vi.fn() } as ProductionBridge)
  try {
    expect(await store.applicationActions.readWorkspaceStorage!("managed-vm-id")).toEqual(storage)
    expect(invoke).toHaveBeenNthCalledWith(1, "read_workspace_storage", { workspaceId: "managed-vm-id" })
    expect(await store.applicationActions.reclaimWorkspaceStorage!("managed-vm-id")).toMatchObject({ workspaceHostBytes: 700, lastReclaimedBytes: 300 })
    expect(invoke).toHaveBeenNthCalledWith(2, "reclaim_workspace_storage", { workspaceId: "managed-vm-id" })
    await expect(store.applicationActions.readWorkspaceStorage!("managed-vm-id")).rejects.toThrow()
  } finally { store.dispose() }
})
