import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import { dismissOperationToast, showOperationProgress } from "@/lib/operation-toast"
import { useLifecycleToasts } from "./use-lifecycle-toasts"

vi.mock("@/lib/operation-toast", () => ({
  dismissOperationToast: vi.fn(),
  showOperationFailure: vi.fn(),
  showOperationNotice: vi.fn(),
  showOperationProgress: vi.fn(),
}))

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

function pendingSource() {
  const source = applicationSourceForScenario("running")
  source.workspaces = [{ ...source.workspaces[0], lifecycleAction: "start" }]
  return source
}

it("shows one delayed progress toast after StrictMode replays setup", () => {
  const source = pendingSource()
  const actions = createApplicationActionsMock()
  renderHook(() => useLifecycleToasts(source, actions), {
    reactStrictMode: true,
  })
  act(() => { vi.advanceTimersByTime(800) })
  expect(showOperationProgress).toHaveBeenCalledExactlyOnceWith(
    `lifecycle::${source.workspaces[0].machine.id}`,
    expect.objectContaining({ title: "Starting dev" }),
  )
})

it("cancels pending notifications when disabled and resumes when enabled", () => {
  const source = pendingSource()
  const actions = createApplicationActionsMock()
  const view = renderHook(({ enabled }) => useLifecycleToasts(source, actions, { enabled }), { initialProps: { enabled: true } })
  act(() => { vi.advanceTimersByTime(400) })
  view.rerender({ enabled: false })
  act(() => { vi.advanceTimersByTime(800) })
  expect(showOperationProgress).not.toHaveBeenCalled()
  view.rerender({ enabled: true })
  act(() => { vi.advanceTimersByTime(800) })
  expect(showOperationProgress).toHaveBeenCalledTimes(1)
})

it("retires progress notifications and timers when the owner unmounts", () => {
  const source = pendingSource()
  const actions = createApplicationActionsMock()
  const view = renderHook(() => useLifecycleToasts(source, actions))
  act(() => { vi.advanceTimersByTime(800) })
  view.unmount()
  expect(dismissOperationToast).toHaveBeenCalledWith(`lifecycle::${source.workspaces[0].machine.id}`)
  expect(vi.getTimerCount()).toBe(0)
})

it("uses the current queue state when delayed progress first appears", () => {
  const source = pendingSource()
  const actions = createApplicationActionsMock()
  const queued = {
    ...source,
    operationQueue: { running: [], waiting: [{
      id: 1, kind: "lifecycle" as const, label: "Starting dev",
      vmId: source.workspaces[0].machine.id, vmName: "dev", sinceMs: Date.now(),
      cancellable: true, expectedMs: null, blockedByHidden: true,
    }] },
  }
  const view = renderHook(({ current }) => useLifecycleToasts(current, actions), { initialProps: { current: queued } })
  act(() => { vi.advanceTimersByTime(400) })
  view.rerender({ current: { ...queued, operationQueue: { running: [], waiting: [] } } })
  act(() => { vi.advanceTimersByTime(400) })
  expect(showOperationProgress).toHaveBeenCalledExactlyOnceWith(
    `lifecycle::${source.workspaces[0].machine.id}`,
    expect.objectContaining({ title: "Starting dev", step: "Starting…" }),
  )
})
