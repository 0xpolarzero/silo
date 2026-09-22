import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { fixtureLogPage, type LogPage, type LogQuery } from "./logs"
import { useLogHistory } from "./use-log-history"

function fixture() {
  const workspace = structuredClone(applicationSourceForScenario("running").workspaces[0])
  workspace.logs = ["10", "09", "08", "07"].map(hour => ({ occurredAt: `2026-09-18T${hour}:00:00Z`, line: `record ${hour}` }))
  const loader = vi.fn(async (request: LogQuery) => fixtureLogPage(workspace, { ...request, limit: 2 }))
  return { workspace, loader, options: { workspaces: [workspace], loader, active: true, query: "", source: "", since: "", until: "", invalidRange: false } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())

describe("cached log history", () => {
  it("restores older pages and scroll position immediately after navigation without fetching", async () => {
    const { options, loader } = fixture()
    const first = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    await act(() => first.result.current.loadOlder())
    act(() => first.result.current.setScrollTop(520))
    const rows = first.result.current.rows
    first.unmount()
    const second = renderHook(() => useLogHistory(options))
    expect(second.result.current.rows).toHaveLength(4)
    expect(second.result.current.scrollTop).toBe(520)
    expect(second.result.current.busy).toBe(false)
    expect(loader).toHaveBeenCalledTimes(2)
    const restoredRows = second.result.current.rows
    act(() => second.result.current.setScrollTop(700))
    expect(second.result.current.rows).toBe(restoredRows)
    expect(rows.map(row => row.entry.id)).toEqual(second.result.current.rows.map(row => row.entry.id))
    second.rerender()
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("deduplicates an unfinished initial request across unmount and remount", async () => {
    const { options, workspace } = fixture()
    const pending = deferred<LogPage>()
    options.loader = vi.fn(() => pending.promise)
    const first = renderHook(() => useLogHistory(options))
    expect(first.result.current.busy).toBe(true)
    first.unmount()
    const second = renderHook(() => useLogHistory(options))
    expect(options.loader).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(fixtureLogPage(workspace, { sandboxId: workspace.machine.id })))
    expect(second.result.current.rows).toHaveLength(4)
  })

  it("caches filters independently and ignores late responses from a previous query", async () => {
    const { options, workspace } = fixture()
    const pending = deferred<LogPage>()
    options.loader = vi.fn(request => request.query === "slow" ? pending.promise : Promise.resolve(fixtureLogPage(workspace, request)))
    const view = renderHook(({ query }) => useLogHistory({ ...options, query }), { initialProps: { query: "slow" } })
    view.rerender({ query: "record 08" })
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1))
    await act(async () => pending.resolve(fixtureLogPage(workspace, { sandboxId: workspace.machine.id })))
    expect(view.result.current.rows[0].entry.line).toBe("record 08")
    view.rerender({ query: "slow" })
    expect(view.result.current.rows).toHaveLength(4)
    expect(options.loader).toHaveBeenCalledTimes(2)
  })

  it("keeps loaded records visible during refresh and does not refresh on activation", async () => {
    const { options, workspace, loader } = fixture()
    const view = renderHook(({ active }) => useLogHistory({ ...options, active }), { initialProps: { active: true } })
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    view.rerender({ active: false })
    view.rerender({ active: true })
    expect(loader).toHaveBeenCalledTimes(1)
    act(() => view.result.current.setScrollTop(520))
    const pending = deferred<LogPage>()
    loader.mockImplementationOnce(() => pending.promise)
    let refresh!: Promise<void>
    act(() => { refresh = view.result.current.refresh() })
    expect(view.result.current.rows).toHaveLength(2)
    expect(view.result.current.busy).toBe(true)
    expect(view.result.current.scrollTop).toBe(520)
    await act(async () => { pending.resolve(fixtureLogPage(workspace, { sandboxId: workspace.machine.id })); await refresh })
    expect(view.result.current.rows).toHaveLength(4)
    expect(view.result.current.scrollTop).toBe(0)
  })

  it("retains healthy owners and successful older pages while retrying only a failed older cursor", async () => {
    const { options, workspace } = fixture()
    const remote = { ...workspace, machine: { ...workspace.machine, id: "remote", name: "remote sandbox" } }
    let fail = true
    options.workspaces = [workspace, remote]
    options.loader = vi.fn(async request => {
      if (request.sandboxId === "remote" && request.cursor && fail) throw new Error("Offline")
      return fixtureLogPage(request.sandboxId === "remote" ? remote : workspace, { ...request, limit: 2 })
    })
    const view = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    await act(() => view.result.current.loadOlder())
    expect(view.result.current.results.map(result => result.page.entries.length)).toEqual([4, 2])
    expect(view.result.current.error).toContain("remote sandbox: Error: Offline")
    fail = false
    await act(() => view.result.current.retry())
    expect(options.loader).toHaveBeenCalledTimes(5)
    expect(options.loader).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxId: "remote", cursor: "2" }))
    expect(view.result.current.rows).toHaveLength(8)
    expect(view.result.current.error).toBe("")
  })

  it("buffers older quiet-owner records until all unfinished owners reach them", async () => {
    const { options, workspace } = fixture()
    const quiet = { ...workspace, machine: { ...workspace.machine, id: "quiet" }, logs: [{ occurredAt: "2026-09-18T06:00:00Z", line: "quiet 06" }] }
    options.workspaces = [workspace, quiet]
    options.loader = vi.fn(async request => fixtureLogPage(request.sandboxId === "quiet" ? quiet : workspace, { ...request, limit: 2 }))
    const view = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    expect(view.result.current.rows.map(row => row.entry.line)).toEqual(["record 10", "record 09"])
    await act(() => view.result.current.loadOlder())
    expect(view.result.current.rows.map(row => row.entry.line)).toEqual(["record 10", "record 09", "record 08", "record 07", "quiet 06"])
  })

  it("preserves loaded history, scroll and an unavailable owner's error when later paging succeeds", async () => {
    const { options, workspace } = fixture()
    const offline = { ...workspace, machine: { ...workspace.machine, id: "offline", name: "offline sandbox" } }
    options.workspaces = [workspace, offline]
    options.loader = vi.fn(async request => {
      if (request.sandboxId === "offline") throw new Error("Disconnected")
      return fixtureLogPage(workspace, { ...request, limit: 2 })
    })
    const view = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    await act(() => view.result.current.loadOlder())
    expect(view.result.current.rows).toHaveLength(4)
    expect(view.result.current.error).toContain("offline sandbox: Error: Disconnected")
    act(() => view.result.current.setScrollTop(100))
    options.loader.mockRejectedValue(new Error("All disconnected"))
    await act(() => view.result.current.refresh())
    expect(view.result.current.rows).toHaveLength(4)
    expect(view.result.current.scrollTop).toBe(100)
    expect(view.result.current.error).toContain("All disconnected")
  })

  it("deduplicates concurrent paging and stops a repeated cursor", async () => {
    const { options, workspace, loader } = fixture()
    const view = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    const pending = deferred<LogPage>()
    loader.mockImplementationOnce(() => pending.promise)
    let older!: Promise<void>
    act(() => { older = view.result.current.loadOlder(); void view.result.current.loadOlder() })
    expect(loader).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve({ ...fixtureLogPage(workspace, { sandboxId: workspace.machine.id, cursor: "2" }), nextCursor: "2" }); await older })
    expect(view.result.current.rows).toHaveLength(4)
    expect(view.result.current.hasOlder).toBe(false)
    expect(view.result.current.error).toContain("did not advance")
    await act(() => view.result.current.loadOlder())
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("expires inactive views before retained backend cursors expire", async () => {
    const { options, loader } = fixture()
    const first = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    first.unmount()
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000)
    try {
      const second = renderHook(() => useLogHistory(options))
      await waitFor(() => expect(second.result.current.ready).toBe(true))
      expect(loader).toHaveBeenCalledTimes(2)
    } finally { vi.restoreAllMocks() }
  })

  it("evicts the least recently used inactive view after the cache fills", async () => {
    const { options, loader } = fixture()
    for (let index = 0; index < 10; index++) {
      const view = renderHook(() => useLogHistory({ ...options, query: String(index) }))
      await waitFor(() => expect(view.result.current.ready).toBe(true))
      view.unmount()
    }
    const last = renderHook(() => useLogHistory({ ...options, query: "9" }))
    expect(last.result.current.ready).toBe(true)
    expect(loader).toHaveBeenCalledTimes(10)
    last.unmount()
    const oldest = renderHook(() => useLogHistory({ ...options, query: "0" }))
    await waitFor(() => expect(oldest.result.current.ready).toBe(true))
    expect(loader).toHaveBeenCalledTimes(11)
  })

  it("releases an oversized inactive history rather than retaining unbounded log text", async () => {
    const { options, workspace, loader } = fixture()
    workspace.logs = [{ line: "x".repeat(4 * 1024 * 1024), occurredAt: "2026-09-18T10:00:00Z" }]
    const first = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    expect(first.result.current.rows).toHaveLength(1)
    first.unmount()
    const second = renderHook(() => useLogHistory(options))
    await waitFor(() => expect(second.result.current.ready).toBe(true))
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
