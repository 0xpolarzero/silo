import { act, renderHook, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { useTransferResultNotice, type TransferResultNotice, type TransferResultNoticeBackend } from "./transfer-result-notice"

const recovered: TransferResultNotice = {
  id: "recovered-import", operation: "restore", outcome: "failed",
  title: "Import interrupted", message: "Silo closed before this import finished.",
}

it("reads recovery results recorded while native listener registration is pending", async () => {
  let notice: TransferResultNotice | null = null
  let register!: () => void
  const registration = new Promise<void>(resolve => { register = resolve })
  const backend: TransferResultNoticeBackend = {
    read: vi.fn(async () => notice), acknowledge: vi.fn(),
    subscribe: async () => { await registration; return () => {} },
  }
  const { result } = renderHook(() => useTransferResultNotice(backend, true))
  await act(async () => {})
  // Recovery finishes before the listener can receive its change event.
  notice = recovered
  await act(async () => register())
  await waitFor(() => expect(result.current.notice).toEqual(recovered))
})

it("still reads the result when native listener registration fails", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const backend: TransferResultNoticeBackend = {
    read: vi.fn(async () => recovered), acknowledge: vi.fn(),
    subscribe: async () => { throw new Error("Event channel unavailable") },
  }
  try {
    const { result } = renderHook(() => useTransferResultNotice(backend, true))
    await waitFor(() => expect(result.current.notice).toEqual(recovered))
    expect(error).toHaveBeenCalledWith("Silo export and import result:", "Event channel unavailable")
  } finally { error.mockRestore() }
})

it("releases a late registration without reading after the view closes", async () => {
  let register!: (stop: () => void) => void
  const registration = new Promise<() => void>(resolve => { register = resolve })
  const backend: TransferResultNoticeBackend = {
    read: vi.fn(async () => recovered), acknowledge: vi.fn(), subscribe: () => registration,
  }
  const view = renderHook(() => useTransferResultNotice(backend, true))
  view.unmount()
  const stop = vi.fn()
  await act(async () => register(stop))
  expect(stop).toHaveBeenCalledOnce()
  expect(backend.read).not.toHaveBeenCalled()
})
