import { act, renderHook, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { usePreUpgradeBackup, type PreUpgradeBackup, type PreUpgradeBackupBackend } from "./pre-upgrade-backup"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it.each(["before", "during"] as const)("does not restore a deleted backup from a read started %s deletion", async when => {
  const backup: PreUpgradeBackup = { deleteAt: null, noticePending: true }
  const stale = deferred<PreUpgradeBackup | null>()
  const deletion = deferred<void>()
  let refresh!: () => void
  const backend: PreUpgradeBackupBackend = {
    read: vi.fn().mockResolvedValueOnce(backup).mockReturnValueOnce(stale.promise),
    remove: () => deletion.promise, measure: vi.fn(), reveal: vi.fn(), acknowledge: vi.fn(),
    subscribe: async handler => { refresh = handler; return () => {} },
  }
  const { result } = renderHook(() => usePreUpgradeBackup(backend, { measure: false }))
  await waitFor(() => expect(result.current.backup).toEqual(backup))
  if (when === "before") await act(async () => refresh())
  let removed!: Promise<void>
  act(() => { removed = result.current.remove() })
  if (when === "during") await act(async () => refresh())
  await act(async () => { deletion.resolve(); await removed })
  expect(result.current.backup).toBeNull()
  await act(async () => stale.resolve(backup))
  expect(result.current.backup).toBeNull()
})

it("ignores backup events while a disposed view waits for registration to finish", async () => {
  const registration = deferred<() => void>()
  let refresh!: () => void
  const backend: PreUpgradeBackupBackend = {
    read: vi.fn(async () => null), remove: vi.fn(), measure: vi.fn(), reveal: vi.fn(), acknowledge: vi.fn(),
    subscribe: handler => { refresh = handler; return registration.promise },
  }
  const view = renderHook(() => usePreUpgradeBackup(backend, { measure: false }))
  view.unmount()
  await act(async () => refresh())
  const stop = vi.fn()
  await act(async () => registration.resolve(stop))
  expect(stop).toHaveBeenCalledOnce()
  expect(backend.read).not.toHaveBeenCalled()
})

it("clears a previous read failure once deletion confirms the backup is gone", async () => {
  const backup: PreUpgradeBackup = { deleteAt: null, noticePending: true }
  let refresh!: () => void
  const backend: PreUpgradeBackupBackend = {
    read: vi.fn().mockResolvedValueOnce(backup).mockRejectedValueOnce(new Error("Backup read failed")),
    remove: vi.fn().mockResolvedValue(undefined), measure: vi.fn(), reveal: vi.fn(), acknowledge: vi.fn(),
    subscribe: async handler => { refresh = handler; return () => {} },
  }
  const { result } = renderHook(() => usePreUpgradeBackup(backend, { measure: false }))
  await waitFor(() => expect(result.current.backup).toEqual(backup))
  await act(async () => refresh())
  expect(result.current.loadError).toBe("Backup read failed")
  await act(async () => result.current.remove())
  expect(result.current.backup).toBeNull()
  expect(result.current.loadError).toBeNull()
})
