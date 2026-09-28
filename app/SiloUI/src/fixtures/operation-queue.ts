import type { OperationQueue } from "@/features/application/model/operation-queue"

/**
 * Deterministic operation-queue fixture: a computer-wide backup running while a
 * restart of "dev" and a checkpoint of "playgrounds" wait their turn behind it.
 * Times are relative to `now` so the preview shows realistic elapsed durations.
 */
export function fixtureOperationQueue(now = Date.now()): OperationQueue {
  return {
    running: [
      { id: 1, label: "Backing up sandboxes", vmId: null, vmName: null, sinceMs: now - 3 * 60_000 },
    ],
    waiting: [
      { id: 2, label: "Restarting dev", vmId: "00000000-0000-4000-8000-000000000001", vmName: "dev", sinceMs: now - 60_000 },
      { id: 3, label: "Checkpointing playgrounds", vmId: "00000000-0000-4000-8000-000000000002", vmName: "playgrounds", sinceMs: now - 30_000 },
    ],
  }
}

/** A single long-running per-VM operation used to preview the "may be stuck" state. */
export function stuckOperationQueue(now = Date.now()): OperationQueue {
  return {
    running: [
      { id: 4, label: "Backing up dev-vm", vmId: "00000000-0000-4000-8000-000000000001", vmName: "dev", sinceMs: now - 12 * 60_000 },
    ],
    waiting: [],
  }
}

/** Selects an operation-queue fixture from a preview URL, e.g. `?operations=stuck`. */
export function operationQueueFromSearch(search: string): OperationQueue | undefined {
  switch (new URLSearchParams(search).get("operations")) {
    case "running":
      return fixtureOperationQueue()
    case "stuck":
      return stuckOperationQueue()
    default:
      return undefined
  }
}
