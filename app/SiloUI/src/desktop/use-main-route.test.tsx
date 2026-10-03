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
  mocks.invoke.mockResolvedValue({ computer: "dev", computerSection: "logs" })
  const { result } = renderHook(() => useMainRoute(true))
  await waitFor(() => expect(result.current).toEqual({ computer: "dev", computerSection: "logs" }))
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

it("keeps a newer main-window route when the startup drain answers last", async () => {
  let notify!: () => void
  let finish!: (value: unknown) => void
  mocks.listen.mockImplementation(async (_name, handler) => { notify = handler; return vi.fn() })
  mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ computer: "newer", computerTab: "storage" })
  const { result } = renderHook(() => useMainRoute(true))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce())
  await act(async () => notify())
  expect(result.current).toEqual({ computer: "newer", computerTab: "storage" })
  await act(async () => finish({ computer: "older", computerSection: "logs" }))
  expect(result.current).toEqual({ computer: "newer", computerTab: "storage" })
})

it("still delivers a pending route when a later drain finds no route", async () => {
  let notify!: () => void
  let finish!: (value: unknown) => void
  mocks.listen.mockImplementation(async (_name, handler) => { notify = handler; return vi.fn() })
  mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(null)
  const { result } = renderHook(() => useMainRoute(true))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce())
  await act(async () => notify())
  await act(async () => finish({ computer: "pending", computerSection: "logs" }))
  expect(result.current).toEqual({ computer: "pending", computerSection: "logs" })
})

it("leaves a pending route for the active listener after StrictMode cleanup", async () => {
  const notify: Array<() => void> = []
  const register: Array<(stop: () => void) => void> = []
  mocks.listen.mockImplementation((_name, handler) => {
    notify.push(handler)
    return new Promise<() => void>(resolve => { register.push(resolve) })
  })
  let pending: unknown = { computer: "pending", computerSection: "logs" }
  mocks.invoke.mockImplementation(async () => {
    const next = pending
    pending = null
    return next
  })
  const { result } = renderHook(() => useMainRoute(true), { reactStrictMode: true })
  expect(notify).toHaveLength(2)
  await act(async () => { notify[0]() })
  const stop = vi.fn()
  await act(async () => { register[0](stop); register[1](vi.fn()) })
  expect(stop).toHaveBeenCalledOnce()
  expect(result.current).toEqual({ computer: "pending", computerSection: "logs" })
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("take_main_route")
})
