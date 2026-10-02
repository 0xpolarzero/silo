import { act, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { UpdatesProvider, useUpdates, type UpdateBackend, type UpdateSnapshot } from "./update-store"

it("keeps consumers stable across equal polls and events but updates the installation gate", async () => {
  vi.useFakeTimers()
  let snapshot: UpdateSnapshot = {
    phase: "ready", lastChecked: null, retryAction: null, currentVersion: "0.1.0",
    availableVersion: "0.2.0", releaseNotes: null, downloadedBytes: 100, totalBytes: 100,
    automaticChecks: true, packageKind: "macos", releaseUrl: "https://example.invalid/releases",
    error: null, errorDetails: null, installBlockReason: null, runningSandboxes: [], canInstall: true,
  }
  let receive!: (next: UpdateSnapshot) => void
  const backend: UpdateBackend = {
    read: vi.fn(async () => structuredClone(snapshot)),
    subscribe: async handler => { receive = handler; return () => {} },
    check: vi.fn(), download: vi.fn(), install: vi.fn(), setAutomaticChecks: vi.fn(), openRelease: vi.fn(),
  }
  let renders = 0
  function Consumer() {
    renders++
    const updates = useUpdates()
    return <button disabled={!updates?.snapshot?.canInstall}>Install</button>
  }
  const view = render(<UpdatesProvider backend={backend}><Consumer /></UpdatesProvider>)
  try {
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByRole("button", { name: "Install" })).toBeEnabled()
    const initialRenders = renders
    for (let tick = 0; tick < 10; tick++) {
      await act(() => vi.advanceTimersByTimeAsync(3000))
    }
    await act(async () => receive(structuredClone(snapshot)))
    expect(backend.read).toHaveBeenCalledTimes(11)
    expect(renders - initialRenders).toBe(0)

    snapshot = { ...snapshot, canInstall: false, installBlockReason: "Wait for active operations." }
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled()
    expect(renders - initialRenders).toBe(1)
    await act(async () => receive({ ...snapshot, canInstall: true, installBlockReason: null }))
    expect(screen.getByRole("button", { name: "Install" })).toBeEnabled()
  } finally { view.unmount(); vi.useRealTimers() }
})
