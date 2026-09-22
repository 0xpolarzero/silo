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
function scrollNearEnd() {
  const viewport = screen.getByRole("table", { name: "Logs" }).querySelector('[data-table-scroll="logs"]') as HTMLElement
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 520 },
    scrollHeight: { configurable: true, get: () => 32 + (Number(screen.getByRole("table", { name: "Logs" }).getAttribute("aria-rowcount")) - 1) * 52 },
  })
  fireEvent.scroll(viewport, { target: { scrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight) } })
  return viewport
}
describe("retained logs", () => {
  it("restores expanded logs alongside the cached history after navigation", async () => {
    const { workspace, actions, queryLogs } = fixture()
    workspace.logs = workspace.logs.slice(0, 2)
    const props = { workspaces: [workspace], actions, active: true, query: "", onQueryChange: vi.fn() }
    const view = render(<Logs {...props} />)
    await screen.findByText("record 1")
    fireEvent.click(screen.getAllByRole("button", { name: /^Expand log/ })[0])
    expect(screen.getByRole("region")).toHaveTextContent("record 1")
    view.unmount()
    render(<Logs {...props} />)
    expect(screen.getByRole("region")).toHaveTextContent("record 1")
    expect(queryLogs).toHaveBeenCalledTimes(1)
  })
  it("renders skeleton rows in the log table until the first page arrives", async () => {
    const { workspace, actions } = fixture()
    workspace.logs = workspace.logs.slice(0, 2)
    let resolve!: (page: LogPage) => void
    actions.queryLogs = vi.fn(() => new Promise<LogPage>(done => { resolve = done }))
    render(<Logs workspaces={[workspace]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    const table = screen.getByRole("table", { name: "Logs" })
    expect(table).toHaveAttribute("aria-busy", "true")
    expect(within(table).getAllByRole("columnheader").map(header => header.textContent)).toContain("Message")
    expect(table.querySelectorAll('[data-log-skeleton]').length).toBeGreaterThan(1)
    expect(screen.queryByText("Loading logs…")).not.toBeInTheDocument()
    await act(async () => resolve(fixtureLogPage(workspace, { sandboxId: workspace.machine.id })))
    expect(screen.getByText("old diagnostic needle")).toBeVisible()
    expect(table.querySelector('[data-log-skeleton]')).toBeNull()
  })
  it("reuses cached pages and scroll position after leaving and returning to logs", async () => {
    const { workspace, actions, queryLogs } = fixture()
    const props = { workspaces: [workspace], actions, active: true, query: "", onQueryChange: vi.fn() }
    const view = render(<Logs {...props} />)
    await screen.findByText(/Showing 200 of 100001/)
    scrollNearEnd()
    await screen.findByText(/Showing 400 of 100001/)
    view.unmount()
    render(<Logs {...props} />)
    expect(screen.getByText(/Showing 400 of 100001/)).toBeVisible()
    expect(screen.getByRole("table", { name: "Logs" }).querySelector('[data-table-scroll="logs"]')?.scrollTop).toBe(9912)
    expect(queryLogs).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument()
  })
  it("preserves the current rows while refreshing and does not reload on reactivation", async () => {
    const { workspace, actions } = fixture()
    workspace.logs = workspace.logs.slice(0, 2)
    let resolve!: (page: LogPage) => void
    const queryLogs = vi.fn()
      .mockImplementationOnce(async (request: LogQuery) => fixtureLogPage(workspace, request))
      .mockImplementationOnce(() => new Promise<LogPage>(done => { resolve = done }))
    actions.queryLogs = queryLogs
    const props = { workspaces: [workspace], actions, query: "", onQueryChange: vi.fn() }
    const view = render(<Logs {...props} active />)
    await screen.findByText("old diagnostic needle")
    view.rerender(<Logs {...props} active={false} />)
    view.rerender(<Logs {...props} active />)
    expect(queryLogs).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Refresh logs" }))
    expect(screen.getByText("old diagnostic needle")).toBeVisible()
    expect(screen.getByRole("button", { name: "Refresh logs" })).toBeDisabled()
    await act(async () => resolve(fixtureLogPage(workspace, { sandboxId: workspace.machine.id })))
    expect(screen.getByRole("button", { name: "Refresh logs" })).toBeEnabled()
  })
  it("starts without source or date filters and uses a quiet empty state", async () => {
    const { workspace, actions, queryLogs } = fixture()
    workspace.logs = []
    render(<Logs workspaces={[workspace]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    expect(await screen.findByText("No logs yet")).toBeVisible()
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ source: undefined, since: undefined, until: undefined }))
    expect(screen.queryByLabelText("Logs from")).not.toBeInTheDocument()
    expect(screen.queryByText(/No logs in this time range/)).not.toBeInTheDocument()
  })
  it("adds, removes and clears optional filters without applying an unfinished date", async () => {
    const { workspace, actions, queryLogs } = fixture()
    workspace.logs = []
    render(<Logs workspaces={[workspace]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText("No logs yet")
    const add = (name: string) => {
      fireEvent.click(screen.getByRole("combobox", { name: "Filter logs" }))
      fireEvent.click(screen.getByRole("option", { name }))
    }
    add("Date filter")
    expect(screen.getByLabelText("From date")).toHaveValue("")
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-09-18" } })
    expect(queryLogs).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("button", { name: "Remove Date filter" })).not.toBeInTheDocument()
    add("Date filter")
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-09-18" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ since: new Date(2026, 8, 18).toISOString(), until: undefined })))
    add("Source: runtime")
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ source: "runtime", since: expect.any(String) })))
    fireEvent.click(screen.getByRole("button", { name: "Remove Date filter" }))
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ source: "runtime", since: undefined, until: undefined })))
    add("Date filter")
    fireEvent.click(screen.getByRole("button", { name: "Last hour" }))
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ source: "runtime", since: expect.any(String) })))
    const callsBeforeClear = queryLogs.mock.calls.length
    fireEvent.click(within(screen.getByRole("group", { name: "Log filters" })).getByRole("button", { name: "Clear" }))
    expect(queryLogs).toHaveBeenCalledTimes(callsBeforeClear)
    expect(screen.queryByRole("button", { name: "Remove Source: runtime filter" })).not.toBeInTheDocument()
    expect(await screen.findByText("No logs yet")).toBeVisible()
  })
  it("expands a matching record inline without fetching surrounding records or clearing filters", async () => {
    const { workspace, actions, queryLogs } = fixture()
    workspace.logs[0].line = "old diagnostic needle\nThe complete diagnostic message remains visible when expanded."
    const window = { since: "2023-11-14T00:00:00Z", until: "2023-11-15T00:00:00Z" }
    const time = new Date(workspace.logs[0].occurredAt).toLocaleTimeString()
    const label = `log from ${workspace.machine.name} at ${time}`
    render(<Logs workspaces={[workspace]} actions={actions} active query="needle" window={window} onQueryChange={vi.fn()} />)
    expect(await screen.findByText(/old diagnostic needle/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: `Expand ${label}` }))
    const details = screen.getByRole("region", { name: `Log details from ${workspace.machine.name} at ${time}` })
    expect(details).toBeVisible()
    expect(details).toHaveTextContent("old diagnostic needle")
    expect(details).toHaveTextContent("The complete diagnostic message remains visible when expanded.")
    expect(screen.getByLabelText("Search logs")).toHaveValue("needle")
    expect(screen.getByText("Showing 1 of 1 matching records.")).toBeVisible()
    expect(queryLogs).toHaveBeenCalledTimes(1)
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ query: "needle", ...window, limit: 200 }))
    fireEvent.click(screen.getByRole("button", { name: `Collapse ${label}` }))
    expect(screen.queryByRole("region", { name: /Log details/ })).not.toBeInTheDocument()
    expect(queryLogs).toHaveBeenCalledTimes(1)
  })
  it("loads older pages with bounded DOM rows, and exports the query rather than the page", async () => {
    const { workspace, actions, queryLogs } = fixture()
    actions.exportLogs = vi.fn(async () => true)
    render(<Logs workspaces={[workspace]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText(/Showing 200 of 100001/)
    scrollNearEnd()
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
    scrollNearEnd()
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
    scrollNearEnd()
    // An owner error pauses automatic pagination until the user retries.
    expect(screen.getByText(/Showing 2 of 4/)).toBeVisible()
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
    fireEvent.click(screen.getByRole("combobox", { name: "Filter logs" }))
    fireEvent.click(screen.getByRole("option", { name: "Source: runtime" }))
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ computerId: "office", sandboxId: "remote-vm", source: "runtime" })))
  })

})
