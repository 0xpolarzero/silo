import { act, render } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { UpdatesProvider, type UpdateBackend, type UpdateSnapshot } from "./update-store"

const ready: UpdateSnapshot = {
  phase: "ready", lastChecked: null, retryAction: null, currentVersion: "0.1.0",
  availableVersion: "0.2.0", releaseNotes: null, downloadedBytes: 100, totalBytes: 100,
  automaticChecks: true, packageKind: "macos", releaseUrl: "https://example.invalid/releases",
  error: null, errorDetails: null, installBlockReason: null, runningComputers: [], canInstall: true,
}

it("backs off failed installation-gate reads and restores normal polling after recovery", async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => ready)
  const backend: UpdateBackend = {
    read, subscribe: async () => () => {}, check: vi.fn(), download: vi.fn(),
    install: vi.fn(), setAutomaticChecks: vi.fn(), openRelease: vi.fn(),
  }
  const advance = async (ms: number) => { await act(() => vi.advanceTimersByTimeAsync(ms)) }
  const view = render(<UpdatesProvider backend={backend}><div /></UpdatesProvider>)
  try {
    await advance(0)
    expect(read).toHaveBeenCalledOnce()
    read.mockRejectedValue(new Error("Updater unavailable"))
    await advance(3000)
    expect(read).toHaveBeenCalledTimes(2)
    for (const delay of [6000, 12000, 24000, 30000, 30000]) {
      const calls = read.mock.calls.length
      await advance(delay - 1)
      expect(read).toHaveBeenCalledTimes(calls)
      await advance(1)
      expect(read).toHaveBeenCalledTimes(calls + 1)
    }
    read.mockResolvedValue(ready)
    await advance(30000)
    const calls = read.mock.calls.length
    await advance(2999)
    expect(read).toHaveBeenCalledTimes(calls)
    await advance(1)
    expect(read).toHaveBeenCalledTimes(calls + 1)
    view.unmount()
    await advance(60000)
    expect(read).toHaveBeenCalledTimes(calls + 1)
  } finally { view.unmount(); vi.useRealTimers() }
})

it("keeps one polling schedule when focus returns during a slow updater read", async () => {
  vi.useFakeTimers()
  let finish!: (snapshot: UpdateSnapshot) => void
  const read = vi.fn(async () => ready)
  const backend: UpdateBackend = {
    read, subscribe: async () => () => {}, check: vi.fn(), download: vi.fn(),
    install: vi.fn(), setAutomaticChecks: vi.fn(), openRelease: vi.fn(),
  }
  const advance = async (ms: number) => { await act(() => vi.advanceTimersByTimeAsync(ms)) }
  const view = render(<UpdatesProvider backend={backend}><div /></UpdatesProvider>)
  try {
    await advance(0)
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await advance(3000)
    await advance(1000)
    act(() => { window.dispatchEvent(new Event("focus")) })
    await advance(1000)
    await act(async () => { finish(ready) })
    await advance(2999)
    expect(read).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(read).toHaveBeenCalledTimes(3)
    await advance(3000)
    expect(read).toHaveBeenCalledTimes(4)
  } finally { view.unmount(); vi.useRealTimers() }
})
