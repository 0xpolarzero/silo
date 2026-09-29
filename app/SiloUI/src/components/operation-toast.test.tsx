import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { formatElapsed } from "@/lib/format-elapsed"
import { showOperationFailure, showOperationProgress, showOperationSuccess, useOperationProgressToast, type OperationProgressState } from "@/lib/operation-toast"

function Host() { return <SettingsProvider initialSettings={{ theme: "light" }}><Toaster /></SettingsProvider> }
const tick = () => act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(50) })

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.useRealTimers() })

describe("showOperationProgress", () => {
  it("renders determinate progress, step, steps and elapsed time", async () => {
    render(<Host />)
    act(() => showOperationProgress("op", { title: "Importing", step: "Copying disk", progress: 0.4, startedAt: Date.now() - 72_000, steps: [{ label: "Verify", state: "done" }, { label: "Copy", state: "current" }, { label: "Boot", state: "pending" }] }))
    await tick()
    expect(screen.getByText("Importing")).toBeInTheDocument()
    const bar = screen.getByRole("progressbar", { name: "Copying disk" })
    expect(bar).toHaveAttribute("aria-valuenow", "40")
    expect(screen.getByRole("list", { name: "Steps" }).querySelectorAll("li")).toHaveLength(3)
    expect(screen.getByText(/^1m 1?\d+s$|^1m \d+s$/)).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText(/^1m \d+s$/)).toBeInTheDocument()
  })

  it("renders an indeterminate bar and updates in place", async () => {
    render(<Host />)
    act(() => showOperationProgress("op", { title: "Working", progress: null }))
    await tick()
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow")
    act(() => showOperationProgress("op", { title: "Working", step: "Next", progress: 0.5 }))
    await tick()
    expect(screen.getAllByText("Working")).toHaveLength(1)
    expect(screen.getByRole("progressbar", { name: "Next" })).toHaveAttribute("aria-valuenow", "50")
  })

  it("cancel without confirm calls onCancel directly", async () => {
    const onCancel = vi.fn()
    render(<Host />)
    act(() => showOperationProgress("op", { title: "Working", cancel: { onCancel } }))
    await tick()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("cancel with confirm shows an inline confirmation that survives updates", async () => {
    const onCancel = vi.fn()
    const cancel = { confirm: { prompt: "Remove the incomplete sandbox?", confirmLabel: "Remove" }, onCancel }
    render(<Host />)
    act(() => showOperationProgress("op", { title: "Working", cancel }))
    await tick()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByText("Remove the incomplete sandbox?")).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
    act(() => showOperationProgress("op", { title: "Working", progress: 0.6, cancel }))
    await tick()
    expect(screen.getByText("Remove the incomplete sandbox?")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }))
    expect(screen.queryByText("Remove the incomplete sandbox?")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("success and failure replace the progress body", async () => {
    render(<Host />)
    act(() => showOperationProgress("op", { title: "Working", cancel: { onCancel: vi.fn() } }))
    await tick()
    act(() => showOperationSuccess("op", "Done"))
    await tick()
    expect(screen.getByText("Done")).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.queryByText("Working")).not.toBeInTheDocument()
    act(() => showOperationProgress("op", { title: "Again" }))
    await tick()
    act(() => showOperationFailure("op", "Failed", { retry: vi.fn() }))
    await tick()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})

describe("useOperationProgressToast", () => {
  function Hooked({ state }: { state: OperationProgressState }) { useOperationProgressToast("hook", state); return null }

  it("ignores finished states at mount and reacts to transitions", async () => {
    const { rerender } = render(<><Host /><Hooked state={{ status: "success", title: "Old result" }} /></>)
    await tick()
    expect(screen.queryByText("Old result")).not.toBeInTheDocument()
    rerender(<><Host /><Hooked state={{ status: "running", title: "Pushing", progress: 0.2 }} /></>)
    await tick()
    expect(screen.getByText("Pushing")).toBeInTheDocument()
    rerender(<><Host /><Hooked state={{ status: "failure", title: "Push failed" }} /></>)
    await tick()
    expect(screen.getByText("Push failed")).toBeInTheDocument()
    expect(screen.queryByText("Pushing")).not.toBeInTheDocument()
  })
})

it("formats elapsed time", () => {
  expect(formatElapsed(5000)).toBe("5s")
  expect(formatElapsed(72_000)).toBe("1m 12s")
  expect(formatElapsed(3_720_000)).toBe("1h 2m")
})
