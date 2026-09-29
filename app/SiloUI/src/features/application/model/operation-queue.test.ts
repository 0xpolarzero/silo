import { describe, expect, it } from "vitest"

import {
  blockingOperations,
  formatElapsed,
  hasPendingOperationForVm,
  isOperationStuck,
  operationMatchesVm,
  operationQueueSchema,
  STUCK_OPERATION_MS,
  toastableQueue,
  waitingOperationForVm,
  waitingStatusText,
  type OperationEntry,
  type OperationQueue,
} from "./operation-queue"

function entry(overrides: Partial<OperationEntry> & Pick<OperationEntry, "id">): OperationEntry {
  const vmId = overrides.vmId ?? null
  return { label: `op-${overrides.id}`, vmId: null, vmName: vmId, sinceMs: 0, cancellable: true, expectedMs: null, blockedByHidden: false, ...overrides }
}

describe("blockingOperations", () => {
  it("blocks a VM operation on computer-wide work and same-VM work only", () => {
    const queue: OperationQueue = {
      running: [
        entry({ id: 1, label: "Backing up sandboxes", vmId: null }),
        entry({ id: 2, label: "Restarting other", vmId: "other" }),
        entry({ id: 3, label: "Checkpointing dev", vmId: "dev" }),
      ],
      waiting: [entry({ id: 4, label: "Restarting dev", vmId: "dev" })],
    }
    const blockers = blockingOperations(queue, queue.waiting[0]).map((item) => item.label)
    expect(blockers).toEqual(["Backing up sandboxes", "Checkpointing dev"])
  })

  it("blocks a computer-wide operation on every running operation", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, vmId: "dev" }), entry({ id: 2, vmId: "playgrounds" })],
      waiting: [entry({ id: 3, label: "Backup", vmId: null })],
    }
    expect(blockingOperations(queue, queue.waiting[0])).toHaveLength(2)
  })
})

describe("waitingStatusText", () => {
  it("names the blocking operations", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up sandboxes", vmId: null })],
      waiting: [entry({ id: 2, label: "Restarting dev", vmId: "dev" })],
    }
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting for Backing up sandboxes…")
  })

  it("joins multiple blockers with a serial comma", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "A", vmId: null }), entry({ id: 2, label: "B", vmId: "dev" })],
      waiting: [entry({ id: 3, label: "C", vmId: "dev" }), entry({ id: 4, label: "D", vmId: "dev" })],
    }
    // Two blockers use "and"; more use a serial comma.
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting for A and B…")
  })

  it("falls back to a plain message when nothing is running (admission race)", () => {
    const queue: OperationQueue = { running: [], waiting: [entry({ id: 1, vmId: "dev" })] }
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting…")
  })
})

describe("VM matching", () => {
  const queue: OperationQueue = {
    running: [entry({ id: 1, vmId: "id-dev", vmName: "dev" })],
    waiting: [
      entry({ id: 2, label: "Restarting dev", vmId: "id-dev", vmName: "dev" }),
      entry({ id: 3, vmId: "id-other", vmName: "other" }),
    ],
  }
  it("matches an entry by stable VM id, not by display name", () => {
    expect(operationMatchesVm(queue.waiting[0], "id-dev")).toBe(true)
    // A renamed VM keeps its id, so the entry (name "dev") still matches by id.
    expect(operationMatchesVm(entry({ id: 8, vmId: "id-dev", vmName: "renamed" }), "id-dev")).toBe(true)
    // A different VM that transiently shares the name does not match.
    expect(operationMatchesVm(entry({ id: 9, vmId: "id-clone", vmName: "dev" }), "id-dev")).toBe(false)
    expect(operationMatchesVm(entry({ id: 10, vmId: null }), "id-dev")).toBe(false)
  })
  it("finds the waiting operation for a VM", () => {
    expect(waitingOperationForVm(queue, "id-dev")?.label).toBe("Restarting dev")
    expect(waitingOperationForVm(queue, "id-missing")).toBeUndefined()
  })
  it("detects a pending (running or waiting) operation for a VM", () => {
    expect(hasPendingOperationForVm(queue, "id-dev")).toBe(true)
    expect(hasPendingOperationForVm(queue, "id-missing")).toBe(false)
  })
})

describe("elapsed formatting", () => {
  it("formats compact durations", () => {
    expect(formatElapsed(5_000)).toBe("just now")
    expect(formatElapsed(3 * 60_000)).toBe("3 min")
    expect(formatElapsed(60 * 60_000)).toBe("1 hr")
    expect(formatElapsed(64 * 60_000)).toBe("1 hr 4 min")
  })
  it("flags an operation as possibly stuck past the threshold", () => {
    const started = entry({ id: 1, vmId: "dev", sinceMs: 0 })
    expect(isOperationStuck(started, STUCK_OPERATION_MS - 1)).toBe(false)
    expect(isOperationStuck(started, STUCK_OPERATION_MS)).toBe(true)
  })
})

describe("waitingStatusText", () => {
  it("names a visible blocker", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up sandboxes", vmId: null })],
      waiting: [entry({ id: 2, label: "Restarting dev", vmId: "dev" })],
    }
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting for Backing up sandboxes…")
  })
  it("describes a hidden blocker generically when no visible operation is running", () => {
    const queue: OperationQueue = { running: [], waiting: [entry({ id: 2, label: "Restarting dev", vmId: "dev", blockedByHidden: true })] }
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting for background maintenance…")
  })
  it("falls back to a bare wait when nothing is known to block it", () => {
    const queue: OperationQueue = { running: [], waiting: [entry({ id: 2, label: "Restarting dev", vmId: "dev" })] }
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting…")
  })
})

describe("toastableQueue", () => {
  it("drops export/import and lifecycle entries, which have their own notifications", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Exporting sandbox" }), entry({ id: 2, label: "Restarting dev", vmId: "dev" })],
      waiting: [entry({ id: 3, label: "Importing sandbox" }), entry({ id: 4, label: "Stopping api", vmId: "api" })],
    }
    const toastable = toastableQueue(queue)
    expect(toastable.running.map((e) => e.label)).toEqual([])
    expect(toastable.waiting.map((e) => e.label)).toEqual([])
  })

  it("keeps operations that have no notification of their own", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Creating checkpoint", vmId: "dev" }), entry({ id: 2, label: "Applying the sandbox configuration" })],
      waiting: [entry({ id: 3, label: "Saving Git identities" }), entry({ id: 4, label: "Stopping local VMs" })],
    }
    const toastable = toastableQueue(queue)
    expect(toastable.running.map((e) => e.label)).toEqual(["Applying the sandbox configuration"])
    expect(toastable.waiting.map((e) => e.label)).toEqual(["Saving Git identities", "Stopping local VMs"])
  })
})

describe("operationQueueSchema", () => {
  it("parses the native camelCase payload", () => {
    const parsed = operationQueueSchema.parse({
      running: [{ id: 1, label: "Backing up", vmId: null, vmName: null, sinceMs: 1000, cancellable: true, expectedMs: 3_600_000, blockedByHidden: false }],
      waiting: [{ id: 2, label: "Restarting dev", vmId: "id-dev", vmName: "dev", sinceMs: 2000, cancellable: true, expectedMs: null }],
    })
    // blockedByHidden defaults to false when the backend omits it.
    expect(parsed.waiting[0].blockedByHidden).toBe(false)
    expect(parsed.running[0].vmId).toBeNull()
    expect(parsed.running[0].cancellable).toBe(true)
    expect(parsed.running[0].expectedMs).toBe(3_600_000)
    expect(parsed.waiting[0].vmId).toBe("id-dev")
    expect(parsed.waiting[0].vmName).toBe("dev")
    expect(parsed.waiting[0].expectedMs).toBeNull()
  })
})
