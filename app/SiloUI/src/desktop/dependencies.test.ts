import { waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { createNativeDependencyStore, validateDependencyReport } from "./dependencies"

const checks = [
  { id: "system-os", title: "Supported OS", status: "pass", detail: "Supported.", remediation: null },
  { id: "system-virtualization", title: "Virtualization", status: "pass", detail: "Available.", remediation: null },
  { id: "runtime-microsandbox", title: "MicroSandbox runtime", status: "pass", detail: "0.6.17", remediation: null },
  { id: "tool-git", title: "Git", status: "pass", detail: "2.53.0", remediation: null },
  { id: "tool-git-lfs", title: "Git LFS", status: "pass", detail: "3.7.1", remediation: null },
] as const

describe("native dependency report validation", () => {
  it("accepts one current result for every required check", () => {
    expect(validateDependencyReport({ schemaVersion: 1, requestId: "current", checkedAtMs: 10_000, checks }, "current", 10_100)).toHaveLength(5)
  })

  it("rejects missing, stale, and mismatched results", () => {
    expect(() => validateDependencyReport({ schemaVersion: 1, requestId: "current", checkedAtMs: 10_000, checks: checks.slice(1) }, "current", 10_100)).toThrow()
    expect(() => validateDependencyReport({ schemaVersion: 1, requestId: "old", checkedAtMs: 10_000, checks }, "current", 10_100)).toThrow(/stale request/)
    expect(() => validateDependencyReport({ schemaVersion: 1, requestId: "current", checkedAtMs: 10_000, checks }, "current", 50_100)).toThrow(/stale result/)
  })

  it("preserves specific timeout and unavailable states", () => {
    const exceptional = checks.map((check) => check.id === "system-virtualization" ? { ...check, status: "timeout" as const, detail: "Timed out." } : check)
    expect(validateDependencyReport({ schemaVersion: 1, requestId: "current", checkedAtMs: 10_000, checks: exceptional }, "current", 10_100)[1]).toMatchObject({ status: "timeout", detail: "Timed out." })
  })

  it("uses the production store to clear a bridge error and recover on Retry", async () => {
    const invokeChecks = vi.fn()
      .mockRejectedValueOnce(new Error("bridge down"))
      .mockImplementationOnce((_command, { requestId }) => Promise.resolve({ schemaVersion: 1, requestId, checkedAtMs: Date.now(), checks }))
    const store = createNativeDependencyStore(invokeChecks)
    store.retry()
    await waitFor(() => expect(store.getSnapshot()[0].status).toBe("unavailable"))
    expect(store.getSnapshot().every(({ remediation }) => remediation?.startsWith("Retry checks.") && !/reinstall/i.test(remediation))).toBe(true)
    store.retry()
    expect(store.getSnapshot().every(({ status }) => status === "pending")).toBe(true)
    await waitFor(() => expect(store.getSnapshot().every(({ status }) => status === "pass")).toBe(true))
    expect(invokeChecks).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it("keeps watchdog timeout terminal when the native result arrives late", async () => {
    vi.useFakeTimers()
    let resolveRequest!: (value: unknown) => void
    const invokeChecks = vi.fn((_command, { requestId }) => new Promise((resolve) => {
      resolveRequest = () => resolve({ schemaVersion: 1, requestId, checkedAtMs: Date.now(), checks })
    }))
    const store = createNativeDependencyStore(invokeChecks)

    store.retry()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getSnapshot().every(({ status }) => status === "timeout")).toBe(true)
    expect(store.getSnapshot().every(({ remediation }) => remediation?.startsWith("Retry checks.") && !/reinstall/i.test(remediation))).toBe(true)
    resolveRequest(undefined)
    await vi.runAllTimersAsync()
    expect(store.getSnapshot().every(({ status }) => status === "timeout")).toBe(true)

    store.dispose()
    vi.useRealTimers()
  })

  it("coalesces repeated Retry requests and ignores the stale in-flight result", async () => {
    const requests: Array<{ requestId: string; resolve: (value: unknown) => void }> = []
    const invokeChecks = vi.fn((_command, { requestId }) => new Promise((resolve) => requests.push({ requestId, resolve })))
    const store = createNativeDependencyStore(invokeChecks)

    store.retry()
    await waitFor(() => expect(requests).toHaveLength(1))
    store.retry()
    store.retry()
    expect(store.getSnapshot().every(({ status }) => status === "pending")).toBe(true)
    expect(invokeChecks).toHaveBeenCalledOnce()

    requests[0].resolve({ schemaVersion: 1, requestId: requests[0].requestId, checkedAtMs: Date.now(), checks })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(store.getSnapshot().every(({ status }) => status === "pending")).toBe(true)
    const unavailable = checks.map((check) => check.id === "system-virtualization" ? { ...check, status: "unavailable" as const } : check)
    requests[1].resolve({ schemaVersion: 1, requestId: requests[1].requestId, checkedAtMs: Date.now(), checks: unavailable })
    await waitFor(() => expect(store.getSnapshot()[1].status).toBe("unavailable"))
    expect(invokeChecks).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it("keeps a queued Retry bounded when the previous bridge request never settles", async () => {
    vi.useFakeTimers()
    const invokeChecks = vi.fn(() => new Promise(() => undefined))
    const store = createNativeDependencyStore(invokeChecks)

    store.retry()
    await Promise.resolve()
    store.retry()
    expect(store.getSnapshot().every(({ status }) => status === "pending")).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getSnapshot().every(({ status }) => status === "timeout")).toBe(true)
    expect(invokeChecks).toHaveBeenCalledOnce()

    store.dispose()
    vi.useRealTimers()
  })

  it("disposes listeners and suppresses late results", async () => {
    let resolveRequest!: (value: unknown) => void
    let requestId = ""
    const listener = vi.fn()
    const invokeChecks = vi.fn((_command, args) => new Promise((resolve) => {
      requestId = args.requestId
      resolveRequest = resolve
    }))
    const store = createNativeDependencyStore(invokeChecks)
    store.subscribe(listener)
    store.retry()
    await waitFor(() => expect(invokeChecks).toHaveBeenCalledOnce())
    store.dispose()
    resolveRequest({ schemaVersion: 1, requestId, checkedAtMs: Date.now(), checks })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().every(({ status }) => status === "pending")).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
  })
})
