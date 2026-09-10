import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useAppMenu, type AppMenuState } from "./app-menu"

const native = vi.hoisted(() => ({ receive: (_event: { payload: string }) => {}, stop: vi.fn(), invoke: vi.fn(async () => {}) }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_name: string, receive: typeof native.receive) => {
  native.receive = receive; return native.stop
} }))
const state: AppMenuState = { ready: true, busy: false, canGoBack: true, canGoForward: true,
  canCreateSandbox: true, canBackup: true, canRestore: true, canCheckUpdates: true, sidebarCollapsed: false }
afterEach(() => vi.restoreAllMocks())

it("routes Linux Control shortcuts and removes the listener on unmount", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64")
  const receive = vi.fn()
  const { unmount } = renderHook(() => useAppMenu(state, receive))
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "6", ctrlKey: true })))
  expect(receive).toHaveBeenCalledWith("go-github")
  unmount()
  receive.mockClear()
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "6", ctrlKey: true }))
  expect(receive).not.toHaveBeenCalled()
})

it("blocks native navigation behind a dialog without breaking palette toggling", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
  const receive = vi.fn()
  const { result } = renderHook(() => useAppMenu(state, receive))
  await waitFor(() => expect(result.current).toBe(true))
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  document.body.append(dialog)
  try {
    act(() => native.receive({ payload: "go-github" }))
    expect(receive).not.toHaveBeenCalled()
    act(() => native.receive({ payload: "search" }))
    expect(receive).toHaveBeenCalledWith("search")
  } finally { dialog.remove() }
  act(() => native.receive({ payload: "go-github" }))
  expect(receive).toHaveBeenLastCalledWith("go-github")
})
