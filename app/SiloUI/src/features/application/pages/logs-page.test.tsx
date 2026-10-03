import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { fixtureLogPage, logPageSchema, type LogPage, type LogQuery } from "../model/logs"
import * as logFormatting from "../model/logs"
import { Toaster } from "@/components/ui/sonner"
import { Logs } from "./logs-page"

function fixture(recordCount = 1001) {
  const computer = structuredClone(applicationSourceForScenario("running").computers[0])
  computer.logs = Array.from({ length: recordCount }, (_, index) => ({ line: index === 0 ? "old diagnostic needle" : `record ${index}`, occurredAt: new Date(1700000000000 + index * 1000).toISOString() }))
  const queryLogs = vi.fn(async (request: LogQuery) => fixtureLogPage(computer, request))
  const actions = { queryLogs } as unknown as ApplicationActions
  return { computer, queryLogs, actions }
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
  it.each([[1, "record"], [2, "records"]])("pluralizes the summary for %i matching %s", async (count, noun) => {
    const { computer, actions } = fixture(count)
    render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    expect(await screen.findByText(`Showing ${count} of ${count} matching ${noun}.`)).toBeVisible()
  })
  it("formats clipboard text on click and copies the current loaded window", async () => {
    const user = userEvent.setup()
    const { computer, actions } = fixture(401)
    const format = vi.spyOn(logFormatting, "formatLog")
    render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText(/Showing 200 of 401/)
    expect(format).not.toHaveBeenCalled()
    scrollNearEnd()
    await screen.findByText(/Showing 400 of 401/)
    expect(format).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Copy logs" }))
    const text = await navigator.clipboard.readText()
    expect(text.split("\n")).toHaveLength(400)
    expect(text).toContain("record 400")
    expect(text).toContain("record 1")
    expect(text).not.toContain("old diagnostic needle")
    expect(format).toHaveBeenCalledTimes(400)
  })

  it("explains the bounded window and exports all matches after records leave the list", async () => {
    const { computer, actions } = fixture(100)
    computer.logs.forEach(log => { log.line += "x".repeat(64 * 1024) })
    actions.exportLogs = vi.fn(async () => true)
    render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText(/Showing 15 of 100/)
    for (let page = 2; page <= 5; page++) {
      scrollNearEnd()
      await screen.findByText(new RegExp(`Showing ${Math.min(63, page * 15)} of 100`))
      await waitFor(() => expect(screen.getByRole("table", { name: "Logs" })).toHaveAttribute("aria-busy", "false"))
    }
    await screen.findByText(/Showing 63 of 100/)
    expect(screen.getByText(/Some loaded records have left this list/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Save logs…" }))
    expect(actions.exportLogs).toHaveBeenCalledWith([expect.objectContaining({ computerId: computer.configuration.id, query: "" })])
    expect(vi.mocked(actions.exportLogs!).mock.calls[0][0][0]).not.toHaveProperty("cursor")
    fireEvent.click(screen.getByRole("button", { name: "Refresh logs" }))
    await screen.findByText(/Showing 15 of 100/)
    expect(screen.queryByText(/Some loaded records have left this list/)).not.toBeInTheDocument()
  })
  it("says when records could not be read and labels times the computer reported", async () => {
    const { computer, actions } = fixture()
    const occurredAt = "2020-01-01T00:00:00.000000000Z"
    const page = logPageSchema.parse({
      entries: [{ id: "1", line: "forged time", occurredAt, computerId: computer.configuration.id, deviceId: "local", source: "kernel", guestTimestamp: true }],
      nextCursor: null, oldestAvailableTimestamp: occurredAt, newestAvailableTimestamp: occurredAt, totalMatches: 1, timestampEstimated: false, unreadableRecords: true,
    })
    actions.queryLogs = vi.fn(async () => page)
    render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    expect(await screen.findByText(/Some records could not be read/)).toBeVisible()
    expect(screen.getByTitle(`${occurredAt} (time reported by the computer)`)).toBeInTheDocument()
  })
  it("restores expanded logs alongside the cached history after navigation", async () => {
    const { computer, actions, queryLogs } = fixture()
    computer.logs = computer.logs.slice(0, 2)
    const props = { computers: [computer], actions, active: true, query: "", onQueryChange: vi.fn() }
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
    const { computer, actions } = fixture()
    computer.logs = computer.logs.slice(0, 2)
    let resolve!: (page: LogPage) => void
    actions.queryLogs = vi.fn(() => new Promise<LogPage>(done => { resolve = done }))
    render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    const table = screen.getByRole("table", { name: "Logs" })
    expect(table).toHaveAttribute("aria-busy", "true")
    expect(within(table).getAllByRole("columnheader").map(header => header.textContent)).toContain("Message")
    expect(table.querySelectorAll('[data-log-skeleton]').length).toBeGreaterThan(1)
    expect(screen.queryByText("Loading logs…")).not.toBeInTheDocument()
    await act(async () => resolve(fixtureLogPage(computer, { computerId: computer.configuration.id })))
    expect(screen.getByText("old diagnostic needle")).toBeVisible()
    expect(table.querySelector('[data-log-skeleton]')).toBeNull()
  })
  it("reuses cached pages and scroll position after leaving and returning to logs", async () => {
    const { computer, actions, queryLogs } = fixture()
    const props = { computers: [computer], actions, active: true, query: "", onQueryChange: vi.fn() }
    const view = render(<Logs {...props} />)
    await screen.findByText(/Showing 200 of 1001/)
    scrollNearEnd()
    await screen.findByText(/Showing 400 of 1001/)
    view.unmount()
    render(<Logs {...props} />)
    expect(screen.getByText(/Showing 400 of 1001/)).toBeVisible()
    expect(screen.getByRole("table", { name: "Logs" }).querySelector('[data-table-scroll="logs"]')?.scrollTop).toBe(9912)
    expect(queryLogs).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument()
  })
  it("preserves the current rows while refreshing and does not reload on reactivation", async () => {
    const { computer, actions } = fixture()
    computer.logs = computer.logs.slice(0, 2)
    let resolve!: (page: LogPage) => void
    const queryLogs = vi.fn()
      .mockImplementationOnce(async (request: LogQuery) => fixtureLogPage(computer, request))
      .mockImplementationOnce(() => new Promise<LogPage>(done => { resolve = done }))
    actions.queryLogs = queryLogs
    const props = { computers: [computer], actions, query: "", onQueryChange: vi.fn() }
    const view = render(<Logs {...props} active />)
    await screen.findByText("old diagnostic needle")
    view.rerender(<Logs {...props} active={false} />)
    view.rerender(<Logs {...props} active />)
    expect(queryLogs).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Refresh logs" }))
    expect(screen.getByText("old diagnostic needle")).toBeVisible()
    expect(screen.getByRole("button", { name: "Refresh logs" })).toBeDisabled()
    await act(async () => resolve(fixtureLogPage(computer, { computerId: computer.configuration.id })))
    expect(screen.getByRole("button", { name: "Refresh logs" })).toBeEnabled()
  })
  it("starts without source or date filters and uses a quiet empty state", async () => {
    const { computer, actions, queryLogs } = fixture()
    computer.logs = []
    render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    expect(await screen.findByText("No logs yet")).toBeVisible()
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ source: undefined, since: undefined, until: undefined }))
    expect(screen.queryByLabelText("Logs from")).not.toBeInTheDocument()
    expect(screen.queryByText(/No logs in this time range/)).not.toBeInTheDocument()
    expect(screen.getByText("No logs yet").closest('[data-slot="empty-state"]')).not.toBeNull()
  })
  it("styles an inverted date range as an inline error with the next step", () => {
    const { computer, actions, queryLogs } = fixture()
    render(<Logs computers={[computer]} actions={actions} active query="" window={{ since: "2026-09-19T00:00:00.000Z", until: "2026-09-18T00:00:00.000Z" }} onQueryChange={vi.fn()} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("The start date is after the end date. Change the date filter to see logs.")
    expect(alert).toHaveClass("text-xs", "text-destructive")
    expect(queryLogs).not.toHaveBeenCalled()
  })
  it("uses the shared empty state when no computer matches", async () => {
    const { actions } = fixture()
    await act(async () => { render(<Logs computers={[]} actions={actions} active query="" onQueryChange={vi.fn()} />) })
    expect(screen.getByText("No matching computers").closest('[data-slot="empty-state"]')).not.toBeNull()
    expect(screen.queryByText(/No computers selected/)).not.toBeInTheDocument()
  })
  it("adds, removes and clears optional filters without applying an unfinished date", async () => {
    const { computer, actions, queryLogs } = fixture()
    computer.logs = []
    render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />)
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
    const { computer, actions, queryLogs } = fixture()
    computer.logs[0].line = "old diagnostic needle\nThe complete diagnostic message remains visible when expanded."
    const window = { since: "2023-11-14T00:00:00Z", until: "2023-11-15T00:00:00Z" }
    const time = new Date(computer.logs[0].occurredAt).toLocaleTimeString()
    const label = `log from ${computer.configuration.name} at ${time}`
    render(<Logs computers={[computer]} actions={actions} active query="needle" window={window} onQueryChange={vi.fn()} />)
    expect(await screen.findByText(/old diagnostic needle/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: `Expand ${label}` }))
    const details = screen.getByRole("region", { name: `Log details from ${computer.configuration.name} at ${time}` })
    expect(details).toBeVisible()
    expect(details).toHaveTextContent("old diagnostic needle")
    expect(details).toHaveTextContent("The complete diagnostic message remains visible when expanded.")
    expect(screen.getByLabelText("Search logs")).toHaveValue("needle")
    expect(screen.getByText("Showing 1 of 1 matching record.")).toBeVisible()
    expect(queryLogs).toHaveBeenCalledTimes(1)
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ query: "needle", ...window, limit: 200 }))
    fireEvent.click(screen.getByRole("button", { name: `Collapse ${label}` }))
    expect(screen.queryByRole("region", { name: /Log details/ })).not.toBeInTheDocument()
    expect(queryLogs).toHaveBeenCalledTimes(1)
  })
  it("loads older pages with bounded DOM rows, and exports the query rather than the page", async () => {
    const { computer, actions, queryLogs } = fixture(100001)
    actions.exportLogs = vi.fn(async () => true)
    render(<><Toaster /><Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} /></>)
    await screen.findByText(/Showing 200 of 100001/)
    scrollNearEnd()
    await screen.findByText(/Showing 400 of 100001/)
    expect(within(screen.getByRole("table")).getAllByRole("row").length).toBeLessThan(70)
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "200" }))
    fireEvent.click(screen.getByRole("button", { name: "Save logs…" }))
    expect(actions.exportLogs).toHaveBeenCalledWith([expect.not.objectContaining({ cursor: expect.any(String) })])
    expect(await within(document.body).findByText("Logs saved")).toBeInTheDocument()
    expect(screen.getByText(/Showing 400 of 100001/).textContent).not.toMatch(/saved/)
  })
  it("reports a failed export with Retry that runs it again", async () => {
    const { computer, actions } = fixture()
    actions.exportLogs = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(true)
    render(<><Toaster /><Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} /></>)
    await screen.findByText(/Showing 200 of 1001/)
    fireEvent.click(screen.getByRole("button", { name: "Save logs…" }))
    expect(await within(document.body).findByText("Could not save logs")).toBeInTheDocument()
    expect(within(document.body).getByText("Disk full")).toBeInTheDocument()
    fireEvent.click(within(document.body).getByRole("button", { name: "Retry" }))
    expect(await within(document.body).findByText("Logs saved")).toBeInTheDocument()
    expect(actions.exportLogs).toHaveBeenCalledTimes(2)
  })

  it("treats a cancelled export picker as silent and allows the next export", async () => {
    const user = userEvent.setup()
    const { computer, actions } = fixture(2)
    actions.exportLogs = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    actions.cancelLogExport = vi.fn().mockResolvedValue(undefined)
    render(<><Toaster /><Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} /></>)
    await screen.findByText("Showing 2 of 2 matching records.")
    const save = screen.getByRole("button", { name: "Save logs…" })
    await user.click(save)
    await waitFor(() => expect(save).toBeEnabled())
    expect(screen.queryByText("Logs saved")).not.toBeInTheDocument()
    expect(screen.queryByText("Could not save logs")).not.toBeInTheDocument()
    expect(actions.cancelLogExport).not.toHaveBeenCalled()
    await user.click(save)
    expect(await screen.findByText("Logs saved")).toBeInTheDocument()
    expect(actions.exportLogs).toHaveBeenCalledTimes(2)
  })

  it("reports cancellation failure without ending the pending export", async () => {
    const user = userEvent.setup()
    const { computer, actions } = fixture(2)
    let finish!: (saved: boolean) => void
    actions.exportLogs = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    actions.cancelLogExport = vi.fn().mockRejectedValue({ code: "internal", message: "Could not stop writing logs" })
    render(<><Toaster /><Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} /></>)
    await screen.findByText("Showing 2 of 2 matching records.")
    const save = screen.getByRole("button", { name: "Save logs…" })
    await user.click(save)
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(await screen.findByText("Could not stop writing logs")).toBeInTheDocument()
    expect(save).toBeDisabled()
    expect(screen.queryByText("Logs saved")).not.toBeInTheDocument()
    await act(async () => finish(true))
    expect(await screen.findByText("Logs saved")).toBeInTheDocument()
    expect(save).toBeEnabled()
    expect(actions.exportLogs).toHaveBeenCalledOnce()
    expect(actions.cancelLogExport).toHaveBeenCalledOnce()
  })

  it("ignores an old response after switching computers and preserves explicit errors", async () => {
    const { computer, actions } = fixture()
    let resolve!: (page: LogPage) => void
    actions.queryLogs = vi.fn().mockImplementationOnce(() => new Promise<LogPage>(done => { resolve = done })).mockRejectedValue(new Error("Host unavailable"))
    const props = { actions, active: true, query: "", onQueryChange: vi.fn() }
    const view = render(<Logs {...props} computers={[computer]} />)
    const other = { ...computer, configuration: { ...computer.configuration, id: "other" } }
    view.rerender(<Logs {...props} computers={[other]} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Host unavailable")
    await act(async () => resolve(fixtureLogPage(computer, { computerId: computer.configuration.id })))
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.queryByText(/No matching logs/)).not.toBeInTheDocument()
  })
  it("keeps healthy device results visible when another owner is unavailable", async () => {
    const { computer, actions } = fixture()
    computer.logs = computer.logs.slice(0, 2)
    const remote = { ...computer, configuration: { ...computer.configuration, id: "remote", name: "remote computer" } }
    actions.queryLogs = vi.fn(async request => {
      if (request.computerId === "remote") throw new Error("Offline")
      return fixtureLogPage(computer, request)
    })
    render(<Logs computers={[computer, remote]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    expect(await screen.findByText("old diagnostic needle")).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("remote computer: Offline")
  })
  it("retries a failed first read from the error control without overlapping requests", async () => {
    const { computer, actions } = fixture(2)
    let resolve!: (page: LogPage) => void
    const queryLogs = vi.fn().mockRejectedValueOnce({ code: "internal", message: "Host unavailable" })
      .mockImplementationOnce(() => new Promise<LogPage>(done => { resolve = done }))
    actions.queryLogs = queryLogs
    render(<Logs computers={[computer]} actions={actions} active query="needle" onQueryChange={vi.fn()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Host unavailable")
    const retry = screen.getByRole("button", { name: "Retry" })

    fireEvent.click(retry)
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(queryLogs).toHaveBeenCalledTimes(2)
    expect(queryLogs.mock.calls[1][0]).toEqual(queryLogs.mock.calls[0][0])

    await act(async () => resolve(fixtureLogPage(computer, queryLogs.mock.calls[1][0])))

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("old diagnostic needle")).toBeVisible()
    expect(screen.getByText("Showing 1 of 1 matching record.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Refresh logs" })).toBeEnabled()
  })
  it("refreshes only while following and active", async () => {
    vi.useFakeTimers()
    try {
      const { computer, actions, queryLogs } = fixture()
      computer.logs = computer.logs.slice(0, 2)
      await act(async () => render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />))
      expect(queryLogs).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole("button", { name: "Follow" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(queryLogs).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByRole("button", { name: "Pause" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(queryLogs).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it("continues the previous snapshot while following, but starts a new search on Refresh and Export", async () => {
    vi.useFakeTimers()
    try {
      const { computer, actions } = fixture()
      computer.logs = computer.logs.slice(0, 2)
      const requests: LogQuery[] = []
      let snapshots = 0
      actions.queryLogs = vi.fn(async (request: LogQuery) => {
        requests.push(request)
        return { ...fixtureLogPage(computer, request), snapshot: `snapshot-${++snapshots}` }
      })
      actions.exportLogs = vi.fn(async () => true)
      await act(async () => render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />))
      fireEvent.click(screen.getByRole("button", { name: "Follow" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(requests.map(request => request.follow)).toEqual([undefined, "snapshot-1", "snapshot-2"])
      fireEvent.click(screen.getByRole("button", { name: "Pause" }))
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh logs" })) })
      expect(requests.at(-1)?.follow).toBeUndefined()
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save logs…" })) })
      expect(vi.mocked(actions.exportLogs!).mock.calls[0][0].every(request => request.follow === undefined)).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it("buffers quiet-owner history until busy-owner pages reach it", async () => {
    const { computer, actions } = fixture()
    computer.logs = ["10", "09", "08", "07"].map(hour => ({ occurredAt: `2026-09-18T${hour}:00:00Z`, line: `busy ${hour}` }))
    const quiet = { ...computer, configuration: { ...computer.configuration, id: "quiet" }, logs: [{ occurredAt: "2026-09-18T06:00:00Z", line: "quiet 06" }] }
    actions.queryLogs = vi.fn(async request => fixtureLogPage(request.computerId === "quiet" ? quiet : computer, { ...request, limit: 2 }))
    render(<Logs computers={[computer, quiet]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText(/Showing 2 of 5/)
    expect(screen.queryByText("quiet 06")).not.toBeInTheDocument()
    scrollNearEnd()
    await screen.findByText(/Showing 5 of 5/)
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1)
    expect(rows.map(row => within(row).getAllByRole("cell")[1].textContent)).toEqual(["busy 10", "busy 09", "busy 08", "busy 07", "quiet 06"])
    expect(within(rows[0]).getByText(new Date("2026-09-18T10:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }))).toBeVisible()
  })
  it("keeps export disabled after loading older records when another owner failed", async () => {
    const { computer, actions } = fixture()
    computer.logs = computer.logs.slice(0, 4)
    const offline = { ...computer, configuration: { ...computer.configuration, id: "offline" } }
    actions.exportLogs = vi.fn(async () => true)
    actions.queryLogs = vi.fn(async request => {
      if (request.computerId === "offline") throw new Error("Offline owner")
      return fixtureLogPage(computer, { ...request, limit: 2 })
    })
    render(<Logs computers={[computer, offline]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByRole("alert")
    scrollNearEnd()
    // An owner error pauses automatic pagination until the user retries.
    expect(screen.getByText(/Showing 2 of 4/)).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("Offline owner")
    expect(screen.getByRole("button", { name: "Save logs…" })).toBeDisabled()
  })
  it("waits for a slow follow scan instead of invalidating its response", async () => {
    vi.useFakeTimers()
    try {
      const { computer, actions } = fixture()
      computer.logs = computer.logs.slice(0, 2)
      let resolve!: (page: LogPage) => void
      const loader = vi.fn().mockImplementationOnce(async (request: LogQuery) => fixtureLogPage(computer, request)).mockImplementationOnce(() => new Promise<LogPage>(done => { resolve = done }))
      actions.queryLogs = loader
      await act(async () => render(<Logs computers={[computer]} actions={actions} active query="" onQueryChange={vi.fn()} />))
      fireEvent.click(screen.getByRole("button", { name: "Follow" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
      expect(loader).toHaveBeenCalledTimes(2)
      await act(async () => resolve(fixtureLogPage(computer, { computerId: computer.configuration.id })))
      expect(screen.getByText("old diagnostic needle")).toBeVisible()
    } finally { vi.useRealTimers() }
  })

  it("addresses a same-named remote computer by owner and VM identity when filtering sources", async () => {
    const { computer, actions } = fixture()
    const remote = { ...computer, configuration: { ...computer.configuration, id: "silo-remote:office:remote-computer" }, device: { id: "office", computerId: "remote-computer", name: "Office", address: "office.local", connected: true } }
    const queryLogs = vi.fn(async () => ({ entries: [], nextCursor: null, oldestAvailableTimestamp: null, newestAvailableTimestamp: null, totalMatches: 0, timestampEstimated: false }))
    actions.queryLogs = queryLogs
    render(<Logs computers={[remote]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await waitFor(() => expect(queryLogs).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "office", computerId: "remote-computer" })))
    fireEvent.click(screen.getByRole("combobox", { name: "Filter logs" }))
    fireEvent.click(screen.getByRole("option", { name: "Source: runtime" }))
    await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: "office", computerId: "remote-computer", source: "runtime" })))
  })

  it("shows one update notice per device instead of raw errors when its Silo cannot serve logs", async () => {
    const { computer, actions } = fixture()
    computer.logs = computer.logs.slice(0, 2)
    const remote = (name: string) => ({ ...computer, configuration: { ...computer.configuration, id: `silo-remote:zeronival:${name}`, name }, device: { id: "zeronival", computerId: name, name: "zeronival", address: "zeronival.local", connected: true } })
    const empty = { entries: [], nextCursor: null, oldestAvailableTimestamp: null, newestAvailableTimestamp: null, totalMatches: 0, timestampEstimated: false }
    actions.queryLogs = vi.fn(async (request: LogQuery) => {
      if (request.deviceId === "zeronival") return { ...empty, unsupported: true }
      return fixtureLogPage(computer, request)
    })
    render(<Logs computers={[computer, remote("dev-zeronival"), remote("trade-zeronival")]} actions={actions} active query="" onQueryChange={vi.fn()} />)
    await screen.findByText("record 1")
    expect(screen.getByText("Update Silo on zeronival to see logs for dev-zeronival and trade-zeronival.")).toBeVisible()
    expect(screen.queryByText(/Logs unavailable/)).not.toBeInTheDocument()
  })

  it.each(["", "needle"])("uses the unsupported remote error code as an update hint without claiming empty logs (query: %s)", async query => {
    const { computer, actions } = fixture()
    const remote = { ...computer, configuration: { ...computer.configuration, id: "silo-remote:zeronival:dev-zeronival", name: "dev-zeronival" }, device: { id: "zeronival", computerId: "dev-zeronival", name: "zeronival", address: "zeronival.local", connected: true } }
    actions.queryLogs = vi.fn(async () => { throw { code: "unsupported_remote_operation", message: "This device cannot query logs." } })
    render(<Logs computers={[remote]} actions={actions} active query={query} onQueryChange={vi.fn()} />)
    expect(await screen.findByText("Update Silo on zeronival to see logs for dev-zeronival.")).toBeVisible()
    expect(screen.queryByText(/Logs unavailable/)).not.toBeInTheDocument()
    expect(screen.queryByText("No logs yet")).not.toBeInTheDocument()
    expect(screen.queryByText("No results")).not.toBeInTheDocument()
  })

})
