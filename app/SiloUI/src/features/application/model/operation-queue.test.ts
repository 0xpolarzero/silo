import { describe, expect, it } from "vitest"

import {
  blockingOperations,
  formatElapsed,
  hasPendingOperationForVm,
  isOperationStuck,
  operationMatchesVm,
  operationQueueSchema,
  STUCK_OPERATION_MS,
  waitingOperationForVm,
  waitingStatusText,
  type OperationEntry,
  type OperationQueue,
} from "./operation-queue"

function entry(overrides: Partial<OperationEntry> & Pick<OperationEntry, "id">): OperationEntry {
  return { label: `op-${overrides.id}`, vm: null, sinceMs: 0, ...overrides }
}

describe("blockingOperations", () => {
  it("blocks a VM operation on computer-wide work and same-VM work only", () => {
    const queue: OperationQueue = {
      running: [
        entry({ id: 1, label: "Backing up sandboxes", vm: null }),
        entry({ id: 2, label: "Restarting other", vm: "other" }),
        entry({ id: 3, label: "Checkpointing dev", vm: "dev" }),
      ],
      waiting: [entry({ id: 4, label: "Restarting dev", vm: "dev" })],
    }
    const blockers = blockingOperations(queue, queue.waiting[0]).map((item) => item.label)
    expect(blockers).toEqual(["Backing up sandboxes", "Checkpointing dev"])
  })

  it("blocks a computer-wide operation on every running operation", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, vm: "dev" }), entry({ id: 2, vm: "playgrounds" })],
      waiting: [entry({ id: 3, label: "Backup", vm: null })],
    }
    expect(blockingOperations(queue, queue.waiting[0])).toHaveLength(2)
  })
})

describe("waitingStatusText", () => {
  it("names the blocking operations", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "Backing up sandboxes", vm: null })],
      waiting: [entry({ id: 2, label: "Restarting dev", vm: "dev" })],
    }
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting for Backing up sandboxes…")
  })

  it("joins multiple blockers with a serial comma", () => {
    const queue: OperationQueue = {
      running: [entry({ id: 1, label: "A", vm: null }), entry({ id: 2, label: "B", vm: "dev" })],
      waiting: [entry({ id: 3, label: "C", vm: "dev" }), entry({ id: 4, label: "D", vm: "dev" })],
    }
    // Two blockers use "and"; more use a serial comma.
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting for A and B…")
  })

  it("falls back to a plain message when nothing is running (admission race)", () => {
    const queue: OperationQueue = { running: [], waiting: [entry({ id: 1, vm: "dev" })] }
    expect(waitingStatusText(queue, queue.waiting[0])).toBe("Waiting…")
  })
})

describe("VM matching", () => {
  const queue: OperationQueue = {
    running: [entry({ id: 1, vm: "dev" })],
    waiting: [entry({ id: 2, label: "Restarting dev", vm: "dev" }), entry({ id: 3, vm: "other" })],
  }
  it("matches an entry by any supplied identifier", () => {
    expect(operationMatchesVm(queue.waiting[0], ["silo-remote:host:dev", "dev"])).toBe(true)
    expect(operationMatchesVm(entry({ id: 9, vm: null }), ["dev"])).toBe(false)
  })
  it("finds the waiting operation for a VM", () => {
    expect(waitingOperationForVm(queue, ["dev"])?.label).toBe("Restarting dev")
    expect(waitingOperationForVm(queue, ["missing"])).toBeUndefined()
  })
  it("detects a pending (running or waiting) operation for a VM", () => {
    expect(hasPendingOperationForVm(queue, ["dev"])).toBe(true)
    expect(hasPendingOperationForVm(queue, ["missing"])).toBe(false)
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
    const started = entry({ id: 1, vm: "dev", sinceMs: 0 })
    expect(isOperationStuck(started, STUCK_OPERATION_MS - 1)).toBe(false)
    expect(isOperationStuck(started, STUCK_OPERATION_MS)).toBe(true)
  })
})

describe("operationQueueSchema", () => {
  it("parses the native camelCase payload", () => {
    const parsed = operationQueueSchema.parse({
      running: [{ id: 1, label: "Backing up", vm: null, sinceMs: 1000 }],
      waiting: [{ id: 2, label: "Restarting dev", vm: "dev", sinceMs: 2000 }],
    })
    expect(parsed.running[0].vm).toBeNull()
    expect(parsed.waiting[0].vm).toBe("dev")
  })
})
