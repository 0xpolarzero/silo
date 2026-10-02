import { act, renderHook, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { EditorIncludeProvider, useEditorIncludeLine } from "./editor-include"
import { useTransferResultNotice } from "./transfer-result-notice"
import { usePreUpgradeBackup } from "@/features/storage/pre-upgrade-backup"

function pendingBackend() {
  let emit!: () => void
  let register!: (stop: () => void) => void
  const registration = new Promise<() => void>(resolve => { register = resolve })
  const backend = {
    read: vi.fn(async () => null),
    subscribe: vi.fn((refresh: () => void) => { emit = refresh; return registration }),
    acknowledge: vi.fn(async () => {}),
    measure: vi.fn(async () => null),
    remove: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
  }
  return { backend, emit: () => emit(), register: (stop: () => void) => register(stop) }
}

type Backend = ReturnType<typeof pendingBackend>["backend"]
const readers = [
  { name: "editor include", render: (backend: Backend) => renderHook(useEditorIncludeLine, { wrapper: ({ children }) => <EditorIncludeProvider backend={backend}>{children}</EditorIncludeProvider> }) },
  { name: "transfer result", render: (backend: Backend) => renderHook(() => useTransferResultNotice(backend, true)) },
  { name: "pre-upgrade backup", render: (backend: Backend) => renderHook(() => usePreUpgradeBackup(backend, { measure: false })) },
]

it.each(readers)("stops $name reads after unmount while registration is pending", async ({ render }) => {
  const mock = pendingBackend()
  const view = render(mock.backend)
  await act(async () => {})
  const reads = mock.backend.read.mock.calls.length
  view.unmount()
  const stop = vi.fn()
  await act(async () => { mock.emit(); mock.register(stop) })
  await act(async () => { mock.emit() })
  expect(stop).toHaveBeenCalledOnce()
  expect(mock.backend.read).toHaveBeenCalledTimes(reads)
})

it.each(readers)("refreshes $name only while its registered listener is live", async ({ render }) => {
  const mock = pendingBackend()
  const view = render(mock.backend)
  const stop = vi.fn()
  await act(async () => { mock.register(stop) })
  await waitFor(() => expect(mock.backend.read).toHaveBeenCalledOnce())
  await act(async () => { mock.emit() })
  expect(mock.backend.read).toHaveBeenCalledTimes(2)
  view.unmount()
  await act(async () => { mock.emit() })
  expect(mock.backend.read).toHaveBeenCalledTimes(2)
  expect(stop).toHaveBeenCalledOnce()
})

it("does not route an obsolete backup callback to its replacement backend", async () => {
  const first = pendingBackend()
  const second = pendingBackend()
  const view = renderHook(({ backend }) => usePreUpgradeBackup(backend, { measure: false }), { initialProps: { backend: first.backend } })
  view.rerender({ backend: second.backend })
  await act(async () => { first.emit() })
  expect(second.backend.read).not.toHaveBeenCalled()
  const stop = vi.fn()
  await act(async () => { first.register(stop); second.register(vi.fn()) })
  expect(stop).toHaveBeenCalledOnce()
  expect(second.backend.read).toHaveBeenCalledOnce()
})
