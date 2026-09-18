import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { fixtureLogPage, type LogPage, type LogQuery } from "../model/logs"
import { Logs } from "./logs-page"

function fixture() {
  const workspace = structuredClone(applicationSourceForScenario("running").workspaces[0])
  workspace.logs = Array.from({ length: 100001 }, (_, index) => ({ line: index === 0 ? "old diagnostic needle" : `record ${index}`, occurredAt: new Date(1700000000000 + index * 1000).toISOString() }))
  const queryLogs = vi.fn(async (request: LogQuery) => fixtureLogPage(workspace, request))
  const actions = { queryLogs } as unknown as ApplicationActions
  return { workspace, queryLogs, actions }
}
describe("retained logs", () => {
  it("finds an error outside 100,000 newer records and shows its surrounding records", async () => {
    const { workspace, actions, queryLogs } = fixture()
    render(<Logs workspaces={[workspace]} actions={actions} active query="needle" onQueryChange={vi.fn()} />)
    expect(await screen.findByText("old diagnostic needle")).toBeVisible()
    expect(queryLogs).toHaveBeenCalledWith(expect.objectContaining({ query: "needle", limit: 200 }))
    fireEvent.click(screen.getByRole("button", { name: "Show surrounding logs for 0" }))
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ aroundId: "0", query: undefined })))
    expect(await screen.findByText("record 1")).toBeInTheDocument()
  })
  it("loads older pages with bounded DOM rows, and exports the query rather than the page", async () => {
    const { workspace, actions, queryLogs } = fixture()
    actions.exportLogs = vi.fn(async () => true)
    render(<Logs workspaces={[workspace]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText(/Showing 200 of 100001/)
    fireEvent.click(screen.getByRole("button", { name: "Load older" }))
    await screen.findByText(/Showing 400 of 100001/)
    expect(within(screen.getByRole("table")).getAllByRole("row").length).toBeLessThan(70)
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "200" }))
    fireEvent.click(screen.getByRole("button", { name: "Export…" }))
    expect(actions.exportLogs).toHaveBeenCalledWith([expect.not.objectContaining({ cursor: expect.any(String) })])
    await screen.findByText(/Logs saved/)
  })
  it("ignores an old response after switching sandboxes and preserves explicit errors", async () => {
    const { workspace, actions } = fixture()
    let resolve!: (page: LogPage) => void
    actions.queryLogs = vi.fn().mockImplementationOnce(() => new Promise<LogPage>(done => { resolve = done })).mockRejectedValue(new Error("Host unavailable"))
    const props = { actions, active: true, query: "", onQueryChange: vi.fn() }
    const view = render(<Logs {...props} workspaces={[workspace]} />)
    const other = { ...workspace, machine: { ...workspace.machine, id: "other" } }
    view.rerender(<Logs {...props} workspaces={[other]} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Host unavailable")
    await act(async () => resolve(fixtureLogPage(workspace, { sandboxId: workspace.machine.id })))
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.queryByText(/No matching logs/)).not.toBeInTheDocument()
  })
  it("keeps healthy computer results visible when another owner is unavailable", async () => {
    const { workspace, actions } = fixture()
    workspace.logs = workspace.logs.slice(0, 2)
    const remote = { ...workspace, machine: { ...workspace.machine, id: "remote", name: "remote sandbox" } }
    actions.queryLogs = vi.fn(async request => {
      if (request.sandboxId === "remote") throw new Error("Offline")
      return fixtureLogPage(workspace, request)
    })
    render(<Logs workspaces={[workspace, remote]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    expect(await screen.findByText("old diagnostic needle")).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("remote sandbox: Error: Offline")
  })
  it("refreshes only while following and active", async () => {
    vi.useFakeTimers()
    try {
      const { workspace, actions, queryLogs } = fixture()
      workspace.logs = workspace.logs.slice(0, 2)
      await act(async () => render(<Logs workspaces={[workspace]} actions={actions} active query="" onQueryChange={vi.fn()} />))
      expect(queryLogs).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole("button", { name: "Follow" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(queryLogs).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByRole("button", { name: "Pause" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(queryLogs).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it("buffers quiet-owner history until busy-owner pages reach it", async () => {
    const { workspace, actions } = fixture()
    workspace.logs = ["10", "09", "08", "07"].map(hour => ({ occurredAt: `2026-09-18T${hour}:00:00Z`, line: `busy ${hour}` }))
    const quiet = { ...workspace, machine: { ...workspace.machine, id: "quiet" }, logs: [{ occurredAt: "2026-09-18T06:00:00Z", line: "quiet 06" }] }
    actions.queryLogs = vi.fn(async request => fixtureLogPage(request.sandboxId === "quiet" ? quiet : workspace, { ...request, limit: 2 }))
    render(<Logs workspaces={[workspace, quiet]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText(/Showing 2 of 5/)
    expect(screen.queryByText("quiet 06")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Load older" }))
    await screen.findByText(/Showing 5 of 5/)
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1)
    expect(rows.map(row => within(row).getAllByRole("cell")[1].textContent)).toEqual(["busy 10", "busy 09", "busy 08", "busy 07", "quiet 06"])
    expect(within(rows[0]).getByText(new Date("2026-09-18T10:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }))).toBeVisible()
  })
  it("keeps export disabled after loading older records when another owner failed", async () => {
    const { workspace, actions } = fixture()
    workspace.logs = workspace.logs.slice(0, 4)
    const offline = { ...workspace, machine: { ...workspace.machine, id: "offline" } }
    actions.exportLogs = vi.fn(async () => true)
    actions.queryLogs = vi.fn(async request => {
      if (request.sandboxId === "offline") throw new Error("Offline owner")
      return fixtureLogPage(workspace, { ...request, limit: 2 })
    })
    render(<Logs workspaces={[workspace, offline]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: "Load older" }))
    await screen.findByText(/Showing 4 of 4/)
    expect(screen.getByRole("alert")).toHaveTextContent("Offline owner")
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled()
  })
  it("waits for a slow follow scan instead of invalidating its response", async () => {
    vi.useFakeTimers()
    try {
      const { workspace, actions } = fixture()
      workspace.logs = workspace.logs.slice(0, 2)
      let resolve!: (page: LogPage) => void
      const loader = vi.fn().mockImplementationOnce(async (request: LogQuery) => fixtureLogPage(workspace, request)).mockImplementationOnce(() => new Promise<LogPage>(done => { resolve = done }))
      actions.queryLogs = loader
      await act(async () => render(<Logs workspaces={[workspace]} actions={actions} active query="" onQueryChange={vi.fn()} />))
      fireEvent.click(screen.getByRole("button", { name: "Follow" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
      expect(loader).toHaveBeenCalledTimes(2)
      await act(async () => resolve(fixtureLogPage(workspace, { sandboxId: workspace.machine.id })))
      expect(screen.getByText("old diagnostic needle")).toBeVisible()
    } finally { vi.useRealTimers() }
  })

  it("addresses a same-named remote sandbox by owner and VM identity when filtering sources", async () => {
    const { workspace, actions } = fixture()
    const remote = { ...workspace, machine: { ...workspace.machine, id: "silo-remote:office:remote-vm" }, computer: { id: "office", vmId: "remote-vm", name: "Office", address: "office.local", connected: true } }
    const queryLogs = vi.fn(async () => ({ entries: [], nextCursor: null, oldestAvailableTimestamp: null, newestAvailableTimestamp: null, totalMatches: 0, timestampEstimated: false }))
    actions.queryLogs = queryLogs
    render(<Logs workspaces={[remote]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await waitFor(() => expect(queryLogs).toHaveBeenCalledWith(expect.objectContaining({ computerId: "office", sandboxId: "remote-vm" })))
    fireEvent.change(screen.getByRole("combobox", { name: "Log source" }), { target: { value: "runtime" } })
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ computerId: "office", sandboxId: "remote-vm", source: "runtime" })))
  })

})
