import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const delivered = vi.hoisted(() => vi.fn())
vi.mock("@/desktop/notices", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/desktop/notices")>()), deliverNotice: delivered }))

import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { showBackendNotice } from "@/features/application/model/use-backend-notices"
import {
  dismissOperationToast,
  dismissSandboxToasts,
  LONG_OPERATION_MS,
  showActionFailure,
  showOperationFailure,
  showOperationNotice,
  showOperationProgress,
  showOperationSuccess,
  showQuickConfirmation,
} from "@/lib/operation-toast"

function Host() { return <SettingsProvider initialSettings={{ theme: "light" }}><Toaster /></SettingsProvider> }
const tick = () => act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(50) })
const sandbox = { id: "vm-1", name: "dev" }

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); delivered.mockClear() })
afterEach(() => { dismissOperationToast("op"); vi.useRealTimers() })

describe("system notice mirroring", () => {
  it("mirrors a failure as a failures notice keyed by the toast id", () => {
    showOperationFailure("op", "Push failed", { description: "rejected", noticeSandbox: sandbox })
    expect(delivered).toHaveBeenCalledExactlyOnceWith({ category: "failures", key: "op", title: "Push failed", body: "rejected", sandbox })
  })

  it("uses an empty body for a non-string description and no sandbox by default", () => {
    showOperationFailure("op", "Import failed", { description: <p>rich</p> })
    expect(delivered).toHaveBeenCalledExactlyOnceWith({ category: "failures", key: "op", title: "Import failed", body: "", sandbox: null })
  })

  it("mirrors an action failure with a key derived from its title", () => {
    showActionFailure("Could not open port 80", new Error("closed"), undefined, { noticeSandbox: sandbox })
    showActionFailure("Could not open port 80", "again")
    expect(delivered).toHaveBeenNthCalledWith(1, { category: "failures", key: "action-failure:Could not open port 80", title: "Could not open port 80", body: "closed", sandbox })
    expect(delivered.mock.calls[1][0].key).toBe("action-failure:Could not open port 80")
  })

  it("mirrors a success only after progress shown for over 3 seconds", () => {
    const start = Date.now()
    showOperationProgress("op", { title: "Working", startedAt: start })
    vi.setSystemTime(start + LONG_OPERATION_MS + 1)
    showOperationSuccess("op", "Done", { description: "took a while", noticeSandbox: sandbox })
    expect(delivered).toHaveBeenCalledExactlyOnceWith({ category: "completions", key: "op", title: "Done", body: "took a while", sandbox })
  })

  it("does not mirror a quick success, a success without progress, a notice, progress, or a quick confirmation", () => {
    const start = Date.now()
    showOperationProgress("op", { title: "Working", startedAt: start })
    vi.setSystemTime(start + 1000)
    showOperationSuccess("op", "Done")
    showOperationSuccess("other", "Done without progress")
    showOperationNotice("op", "Cancelled")
    showQuickConfirmation("Copied")
    expect(delivered).not.toHaveBeenCalled()
  })

  it("does not mirror when native is false", () => {
    const start = Date.now()
    showOperationProgress("op", { title: "Working", startedAt: start })
    vi.setSystemTime(start + LONG_OPERATION_MS + 1)
    showOperationSuccess("op", "Done", { native: false })
    showOperationFailure("op", "Failed", { native: false })
    showActionFailure("Nope", "x", undefined, { native: false })
    expect(delivered).not.toHaveBeenCalled()
  })
})

describe("backend notices", () => {
  it("renders by category, replaces by key in place, tags the sandbox, and never re-delivers", async () => {
    render(<Host />)
    act(() => showBackendNotice({ category: "changes", key: "state:vm-1", title: "dev stopped unexpectedly", body: "", sandbox }))
    await tick()
    expect(screen.getByText("dev stopped unexpectedly")).toBeInTheDocument()
    act(() => showBackendNotice({ category: "changes", key: "state:vm-1", title: "dev is running again", body: "Recovered.", sandbox }))
    await tick()
    expect(screen.queryByText("dev stopped unexpectedly")).not.toBeInTheDocument()
    expect(screen.getAllByText("dev is running again")).toHaveLength(1)
    act(() => showBackendNotice({ category: "failures", key: "update", title: "Update failed", body: "offline", sandbox: null }))
    act(() => showBackendNotice({ category: "completions", key: "done", title: "Export finished", body: "", sandbox: null }))
    await tick()
    expect(screen.getByText("Update failed")).toBeInTheDocument()
    expect(screen.getByText("Export finished")).toBeInTheDocument()
    act(() => dismissSandboxToasts("dev"))
    await tick()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.queryByText("dev is running again")).not.toBeInTheDocument()
    expect(delivered).not.toHaveBeenCalled()
  })
})
