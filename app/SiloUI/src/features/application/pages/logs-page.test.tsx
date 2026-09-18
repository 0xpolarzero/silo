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
    fireEvent.click(screen.getByRole("button", { name: "Export matches" }))
    expect(actions.exportLogs).toHaveBeenCalledWith([expect.not.objectContaining({ cursor: expect.any(String) })])
    await screen.findByText(/Export saved/)
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

})
