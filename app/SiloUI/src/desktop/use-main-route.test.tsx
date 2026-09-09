import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { useMainRoute } from "./use-main-route"
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
beforeEach(() => vi.resetAllMocks())
it("delivers a pending route after subscribing and receives repeated requests", async () => {
  let notify = () => {}
  mocks.listen.mockImplementation(async (_name, handler) => { notify = handler; return vi.fn() })
  mocks.invoke.mockResolvedValue({ workspace: "dev", workspaceSection: "logs" })
  const { result } = renderHook(() => useMainRoute(true))
  await waitFor(() => expect(result.current).toEqual({ workspace: "dev", workspaceSection: "logs" }))
  expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0])
  const previous = result.current
  await act(async () => notify())
  expect(result.current).not.toBe(previous)
  mocks.invoke.mockResolvedValue({ tab: "system" })
  await act(async () => notify())
  expect(result.current).toEqual({ tab: "system" })
})
it("does not consume main-window requests from the status panel", () => {
  renderHook(() => useMainRoute(false))
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(mocks.listen).not.toHaveBeenCalled()
})
