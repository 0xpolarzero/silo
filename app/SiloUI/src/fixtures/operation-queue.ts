import type { OperationQueue } from "@/features/application/model/operation-queue"

/**
 * Deterministic operation-queue fixture: a device-wide backup running while a
 * restart of "dev" and a checkpoint of "playgrounds" wait their turn behind it.
 * Times are relative to `now` so the preview shows realistic elapsed durations.
 */
export function fixtureOperationQueue(now = Date.now()): OperationQueue {
  return {
    running: [
      { id: 1, label: "Backing up computers", kind: "other", computerId: null, computerName: null, sinceMs: now - 3 * 60_000, cancellable: true, expectedMs: 60 * 60_000, blockedByHidden: false },
    ],
    waiting: [
      { id: 2, label: "Restarting dev", kind: "lifecycle", computerId: "00000000-0000-4000-8000-000000000001", computerName: "dev", sinceMs: now - 60_000, cancellable: true, expectedMs: 3 * 60_000, blockedByHidden: false },
      { id: 3, label: "Checkpointing playgrounds", kind: "checkpointCapture", computerId: "00000000-0000-4000-8000-000000000002", computerName: "playgrounds", sinceMs: now - 30_000, cancellable: true, expectedMs: 15 * 60_000, blockedByHidden: false },
    ],
  }
}

/** A single long-running per-computer operation used to preview the "taking longer than expected" state. */
export function stuckOperationQueue(now = Date.now()): OperationQueue {
  return {
    running: [
      { id: 4, label: "Backing up dev-vm", kind: "other", computerId: "00000000-0000-4000-8000-000000000001", computerName: "dev", sinceMs: now - 12 * 60_000, cancellable: true, expectedMs: 10 * 60_000, blockedByHidden: false },
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
