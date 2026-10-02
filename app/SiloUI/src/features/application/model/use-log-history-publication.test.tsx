import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { fixtureLogPage, type LogPage, type LogQuery } from "./logs"
import { useLogHistory } from "./use-log-history"

function deferred() {
  let resolve!: (page: LogPage) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<LogPage>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const local = structuredClone(applicationSourceForScenario("running").workspaces[0])
  local.logs = [{ occurredAt: "2026-09-18T10:00:00Z", line: "previous local" }]
  const remote = { ...local, machine: { ...local.machine, id: "remote-vm" }, computer: { id: "office", vmId: "vm-1", name: "Office", address: "owner@office", connected: true }, logs: [{ occurredAt: "2026-09-18T09:00:00Z", line: "previous remote" }] }
  const loader = vi.fn(async (request: LogQuery) => fixtureLogPage(request.computerId ? remote : local, request))
  const options = { workspaces: [local, remote], loader, active: true, query: "", source: "", since: "", until: "", invalidRange: false }
  const current = fixtureLogPage({ ...local, logs: [{ occurredAt: "2026-09-18T11:00:00Z", line: "current local" }] }, { sandboxId: local.machine.id })
  return { local, remote, loader, options, current }
}

describe("independent log owner publication", () => {
  it.each([false, true])("publishes a completed local read while remote remains pending (refresh: %s)", async (refresh) => {
    const { local, remote, loader, options, current } = fixture()
    const localRead = deferred()
    const remoteRead = deferred()
    if (!refresh) loader.mockImplementation(request => request.computerId ? remoteRead.promise : localRead.promise)
    const view = renderHook(() => useLogHistory(options))
    let completion: Promise<void> | undefined
    if (refresh) {
      await waitFor(() => expect(view.result.current.busy).toBe(false))
      expect(view.result.current.ready).toBe(true)
      loader.mockImplementation(request => request.computerId ? remoteRead.promise : localRead.promise)
      act(() => { completion = view.result.current.refresh() })
    }
    try {
      await act(async () => localRead.resolve(current))
      expect(view.result.current.rows.find(row => row.workspace.machine.id === local.machine.id)?.entry.line).toBe("current local")
      expect(view.result.current.ready).toBe(true)
      expect(view.result.current.busy).toBe(true)
      if (refresh) expect(view.result.current.rows.find(row => row.workspace.machine.id === remote.machine.id)?.entry.line).toBe("previous remote")
    } finally {
      await act(async () => { remoteRead.resolve(fixtureLogPage(remote, { computerId: "office", sandboxId: "vm-1" })); await completion })
    }
    await waitFor(() => expect(view.result.current.busy).toBe(false))
    expect(view.result.current.rows.map(row => row.entry.line)).toEqual(["current local", "previous remote"])
  })

  it("publishes a completed owner's error while another owner remains pending", async () => {
    const { remote, loader, options } = fixture()
    const localRead = deferred()
    const remoteRead = deferred()
    loader.mockImplementation(request => request.computerId ? remoteRead.promise : localRead.promise)
    const view = renderHook(() => useLogHistory(options))
    try {
      await act(async () => localRead.reject(new Error("Local read failed")))
      expect(view.result.current.error).toContain("Local read failed")
      expect(view.result.current.ready).toBe(true)
      expect(view.result.current.busy).toBe(true)
    } finally {
      await act(async () => remoteRead.resolve(fixtureLogPage(remote, { computerId: "office", sandboxId: "vm-1" })))
    }
    await waitFor(() => expect(view.result.current.busy).toBe(false))
  })
})
