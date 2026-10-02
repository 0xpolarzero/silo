import { act, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setupFakeTimerUser } from "@/test/fake-timer-user"
import { toast } from "sonner"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { fixtureOperationQueue } from "@/fixtures/operation-queue"
import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { OperationQueueToast } from "../components/operation-queue-panel"
import type { ApplicationActions } from "../model/application-source"
import type { OperationEntry, OperationQueue } from "../model/operation-queue"
import { OverviewPage } from "./overview-page"

const actions = {} as ApplicationActions

function entry(overrides: Partial<OperationEntry> & Pick<OperationEntry, "id" | "label">): OperationEntry {
  return { kind: "other", vmId: null, vmName: null, sinceMs: 0, cancellable: false, expectedMs: null, blockedByHidden: false, ...overrides }
}

/** Renders the toast driver with a mounted Toaster so the notification appears in the DOM. */
function ToastHarness({ queue, onCancel }: { queue: OperationQueue; onCancel?: (id: number) => void }) {
  return <SettingsProvider initialSettings={{ theme: "light" }}>
    <Toaster />
    <OperationQueueToast queue={queue} onCancel={onCancel} />
  </SettingsProvider>
}

afterEach(() => { toast.dismiss(); vi.useRealTimers() })

it("shows what a waiting sandbox operation is waiting for, near that sandbox", () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.operationQueue = fixtureOperationQueue()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} />)

  const row = within(screen.getByText("dev").closest("li")!)
  expect(row.getByText("Waiting for Backing up sandboxes…")).toBeVisible()
})

describe("operation-queue toast", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"] }) })
  it("shows a title and elapsed time for a running operation, and lists waiting entries", async () => {
    render(<ToastHarness queue={fixtureOperationQueue()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Backing up sandboxes")).toBeInTheDocument()
    expect(screen.getByText("3m 0s")).toBeInTheDocument()
    // The waiting restart has its own lifecycle notification, so the queue toast omits it.
    expect(screen.queryByText(/Restarting dev/)).not.toBeInTheDocument()
  })

  it("lists an otherwise-invisible waiting entry behind a running one", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up sandboxes", sinceMs: Date.now() - 1000 })],
      waiting: [entry({ id: 2, label: "Saving Git identities" }), entry({ id: 3, label: "Restarting dev", kind: "lifecycle", vmId: "dev" })],
    }
    render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(/Saving Git identities — Waiting for Backing up sandboxes…/)).toBeInTheDocument()
  })

  it.each([
    ["Creating checkpoint", "checkpointCapture"], ["Restoring checkpoint", "checkpointRestore"], ["Forking checkpoint", "checkpointFork"],
    ["Starting dev", "lifecycle"], ["Stopping dev", "lifecycle"], ["Restarting dev", "lifecycle"],
    ["Applying GitHub access to dev", "githubApply"], ["Pushing from dev", "push"],
    ["Publishing a port on dev", "portPublish"], ["Removing a port on dev", "portRemove"], ["Reclaiming sandbox storage", "storageReclaim"],
  ] as const)("does not show a queue toast for %s (%s), which has its own notification", async (label, kind) => {
    const queue: OperationQueue = { running: [entry({ id: 1, label, kind, vmId: "dev", cancellable: true, sinceMs: Date.now() - 60_000 })], waiting: [] }
    render(<ToastHarness queue={queue} onCancel={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.queryByText(label)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("summarises multiple operations with a count when none is uniquely running", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up sandboxes" }), entry({ id: 2, label: "Updating" })],
      waiting: [],
    }
    render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("2 operations in progress")).toBeInTheDocument()
  })

  it("does not flash a toast for an operation that finishes within the debounce window", async () => {
    vi.useFakeTimers()
    const queue: OperationQueue = { running: [entry({ id: 1, label: "Saving Git identities", sinceMs: Date.now() })], waiting: [] }
    const { rerender } = render(<ToastHarness queue={queue} />)
    // Before 500 ms the toast must not appear.
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.queryByText("Saving Git identities")).not.toBeInTheDocument()
    // The operation completes before the debounce elapses: still nothing.
    rerender(<ToastHarness queue={{ running: [], waiting: [] }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.queryByText("Saving Git identities")).not.toBeInTheDocument()
  })

  it("shows the toast once an operation outlives the debounce window", async () => {
    const queue: OperationQueue = { running: [entry({ id: 1, label: "Saving Git identities", sinceMs: Date.now() })], waiting: [] }
    render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // Not shown immediately (debounced), but it appears once the window elapses.
    expect(screen.queryByText("Saving Git identities")).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    // React publishes the toast after the debounce callback; Sonner queues its DOM update.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Saving Git identities")).toBeInTheDocument()
  })

  it("debounces a fresh operation when it replaces the previous queue without an empty snapshot", async () => {
    const queue: OperationQueue = { running: [entry({ id: 1, label: "Backing up sandboxes", sinceMs: Date.now() - 1000 })], waiting: [] }
    const { rerender } = render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Backing up sandboxes")).toBeInTheDocument()
    rerender(<ToastHarness queue={{ running: [entry({ id: 2, label: "Saving Git identities", sinceMs: Date.now() })], waiting: [] }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByText("Saving Git identities")).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Saving Git identities")).toBeInTheDocument()
  })

  it("keeps a quick replacement silent when it finishes before the debounce", async () => {
    const previous: OperationQueue = { running: [entry({ id: 1, label: "Checking sandbox", sinceMs: Date.now() - 1000 })], waiting: [] }
    const view = render(<ToastHarness queue={previous} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Checking sandbox")).toBeInTheDocument()

    const next: OperationQueue = { running: [entry({ id: 2, label: "Reading sandbox files", sinceMs: Date.now() })], waiting: [] }
    view.rerender(<ToastHarness queue={next} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.queryByText("Reading sandbox files")).not.toBeInTheDocument()
    view.rerender(<ToastHarness queue={{ running: [], waiting: [] }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.queryByText("Reading sandbox files")).not.toBeInTheDocument()
  })

  it("keeps a replacement visible when it has already waited longer than the debounce", async () => {
    const previous = entry({ id: 1, label: "Checking sandbox", sinceMs: Date.now() - 1000 })
    const next = entry({ id: 2, label: "Reading sandbox files", sinceMs: Date.now() - 600 })
    const view = render(<ToastHarness queue={{ running: [previous], waiting: [next] }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    view.rerender(<ToastHarness queue={{ running: [next], waiting: [] }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Reading sandbox files")).toBeInTheDocument()
  })

  it("flags an operation past its expected duration as taking longer than expected", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up dev-vm", vmId: "dev", sinceMs: Date.now() - 6 * 60_000, expectedMs: 5 * 60_000 })],
      waiting: [],
    }
    render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Taking longer than expected")).toBeInTheDocument()
  })

  it("excludes export and import entries, which have their own transfer toast", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Exporting sandbox", kind: "export", cancellable: true }), entry({ id: 2, label: "Applying the sandbox configuration", vmId: "dev", sinceMs: Date.now() - 60_000 })],
      waiting: [entry({ id: 3, label: "Importing sandbox", kind: "import" })],
    }
    render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // Only the non-transfer entry drives the toast title.
    expect(screen.getByText("Applying the sandbox configuration")).toBeInTheDocument()
    expect(screen.queryByText("Exporting sandbox")).not.toBeInTheDocument()
    expect(screen.queryByText(/Importing sandbox/)).not.toBeInTheDocument()
  })

  it("offers Cancel for a cancellable running operation and invokes onCancel", async () => {
    const user = setupFakeTimerUser()
    const onCancel = vi.fn()
    const queue: OperationQueue = {
      running: [entry({ id: 7, label: "Applying the sandbox configuration", vmId: "dev", cancellable: true })],
      waiting: [],
    }
    render(<ToastHarness queue={queue} onCancel={onCancel} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledWith(7)
  })

  it("names the operation Cancel stops when several are in progress", async () => {
    const user = setupFakeTimerUser()
    const onCancel = vi.fn()
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Updating" }), entry({ id: 9, label: "Backing up sandboxes", cancellable: true })],
      waiting: [],
    }
    render(<ToastHarness queue={queue} onCancel={onCancel} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("2 operations in progress")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel “Backing up sandboxes”" }))
    expect(onCancel).toHaveBeenCalledWith(9)
  })

  it("does not offer Cancel for a non-cancellable running operation", async () => {
    const queue: OperationQueue = { running: [entry({ id: 8, label: "Applying the sandbox configuration", vmId: "dev", cancellable: false })], waiting: [] }
    render(<ToastHarness queue={queue} onCancel={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Applying the sandbox configuration")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("dismisses the toast when the queue empties", async () => {
    const queue: OperationQueue = { running: [entry({ id: 1, label: "Backing up sandboxes" })], waiting: [] }
    const { rerender } = render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText("Backing up sandboxes")).toBeInTheDocument()
    rerender(<ToastHarness queue={{ running: [], waiting: [] }} />)
    // Sonner dispatches dismissal on one frame and updates the DOM on the next.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { vi.advanceTimersToNextFrame() })
    await act(async () => { vi.advanceTimersToNextFrame() })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByText("Backing up sandboxes")).not.toBeInTheDocument()
  })

  it("describes a wait held up only by hidden background maintenance generically", async () => {
    const queue: OperationQueue = {
      running: [],
      waiting: [entry({ id: 1, label: "Saving Git identities", vmId: "dev", blockedByHidden: true, sinceMs: Date.now() - 60_000 })],
    }
    render(<ToastHarness queue={queue} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(/Saving Git identities — Waiting for background maintenance…/)).toBeInTheDocument()
  })
})
