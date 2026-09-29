import { act, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
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
  return { vmId: null, vmName: null, sinceMs: 0, cancellable: false, expectedMs: null, blockedByHidden: false, ...overrides }
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
  it("shows a title and elapsed time for a running operation, and lists waiting entries", async () => {
    render(<ToastHarness queue={fixtureOperationQueue()} />)
    expect(await screen.findByText("Backing up sandboxes")).toBeInTheDocument()
    expect(screen.getByText("3m 0s")).toBeInTheDocument()
    // The waiting restart has its own lifecycle notification, so the queue toast omits it.
    expect(screen.queryByText(/Restarting dev/)).not.toBeInTheDocument()
  })

  it("lists an otherwise-invisible waiting entry behind a running one", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up sandboxes", sinceMs: Date.now() - 1000 })],
      waiting: [entry({ id: 2, label: "Saving Git identities" }), entry({ id: 3, label: "Restarting dev", vmId: "dev" })],
    }
    render(<ToastHarness queue={queue} />)
    expect(await screen.findByText(/Saving Git identities — Waiting for Backing up sandboxes…/)).toBeInTheDocument()
  })

  it.each(["Creating checkpoint", "Restoring checkpoint", "Forking checkpoint", "Starting dev", "Stopping dev", "Restarting dev", "Applying GitHub access to dev", "Pushing from dev", "Publishing a port on dev", "Removing a port on dev", "Reclaiming sandbox storage"])("does not show a queue toast for %s, which has its own notification", async (label) => {
    const queue: OperationQueue = { running: [entry({ id: 1, label, vmId: "dev", cancellable: true, sinceMs: Date.now() - 60_000 })], waiting: [] }
    render(<ToastHarness queue={queue} onCancel={vi.fn()} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) })
    expect(screen.queryByText(label)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("summarises multiple operations with a count when none is uniquely running", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up sandboxes" }), entry({ id: 2, label: "Updating" })],
      waiting: [],
    }
    render(<ToastHarness queue={queue} />)
    expect(await screen.findByText("2 operations in progress")).toBeInTheDocument()
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
    // Not shown immediately (debounced), but it appears once the window elapses.
    expect(screen.queryByText("Saving Git identities")).not.toBeInTheDocument()
    expect(await screen.findByText("Saving Git identities", {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it("flags an operation past its expected duration as taking longer than expected", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up dev-vm", vmId: "dev", sinceMs: Date.now() - 6 * 60_000, expectedMs: 5 * 60_000 })],
      waiting: [],
    }
    render(<ToastHarness queue={queue} />)
    expect(await screen.findByText("Taking longer than expected")).toBeInTheDocument()
  })

  it("excludes export and import entries, which have their own transfer toast", async () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Exporting sandbox", cancellable: true }), entry({ id: 2, label: "Applying the sandbox configuration", vmId: "dev", sinceMs: Date.now() - 60_000 })],
      waiting: [entry({ id: 3, label: "Importing sandbox" })],
    }
    render(<ToastHarness queue={queue} />)
    // Only the non-transfer entry drives the toast title.
    expect(await screen.findByText("Applying the sandbox configuration")).toBeInTheDocument()
    expect(screen.queryByText("Exporting sandbox")).not.toBeInTheDocument()
    expect(screen.queryByText(/Importing sandbox/)).not.toBeInTheDocument()
  })

  it("offers Cancel for a cancellable running operation and invokes onCancel", async () => {
    const user = (await import("@testing-library/user-event")).default.setup()
    const onCancel = vi.fn()
    const queue: OperationQueue = {
      running: [entry({ id: 7, label: "Applying the sandbox configuration", vmId: "dev", cancellable: true })],
      waiting: [],
    }
    render(<ToastHarness queue={queue} onCancel={onCancel} />)
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledWith(7)
  })

  it("does not offer Cancel for a non-cancellable running operation", async () => {
    const queue: OperationQueue = { running: [entry({ id: 8, label: "Applying the sandbox configuration", vmId: "dev", cancellable: false })], waiting: [] }
    render(<ToastHarness queue={queue} onCancel={vi.fn()} />)
    expect(await screen.findByText("Applying the sandbox configuration")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("dismisses the toast when the queue empties", async () => {
    const queue: OperationQueue = { running: [entry({ id: 1, label: "Backing up sandboxes" })], waiting: [] }
    const { rerender } = render(<ToastHarness queue={queue} />)
    expect(await screen.findByText("Backing up sandboxes")).toBeInTheDocument()
    rerender(<ToastHarness queue={{ running: [], waiting: [] }} />)
    await vi.waitFor(() => expect(screen.queryByText("Backing up sandboxes")).not.toBeInTheDocument())
  })

  it("describes a wait held up only by hidden background maintenance generically", async () => {
    const queue: OperationQueue = {
      running: [],
      waiting: [entry({ id: 1, label: "Saving Git identities", vmId: "dev", blockedByHidden: true, sinceMs: Date.now() - 60_000 })],
    }
    render(<ToastHarness queue={queue} />)
    expect(await screen.findByText(/Saving Git identities — Waiting for background maintenance…/)).toBeInTheDocument()
  })
})
