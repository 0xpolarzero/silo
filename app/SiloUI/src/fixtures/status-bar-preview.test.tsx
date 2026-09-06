import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import App from "@/App"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { StatusBarPreview } from "@/fixtures/status-bar-preview"
import { statusBarFixtureModeFromSearch, statusBarSourceForFixture } from "@/fixtures/status-bar-scenarios"

const originalURL = window.location.href
afterEach(() => window.history.replaceState(null, "", originalURL))

describe("status bar preview", () => {
  it("adds bounded stale, empty, and long-list fixtures without changing the source", () => {
    const source = applicationSourceForScenario("running")
    expect(statusBarFixtureModeFromSearch("?status-bar=unknown")).toBeUndefined()
    expect(statusBarFixtureModeFromSearch("?status-bar=stale")).toBe("stale")
    expect(statusBarSourceForFixture(source, "stale").workspaces.every(({ freshness }) => freshness === "stale")).toBe(true)
    expect(statusBarSourceForFixture(source, "empty").workspaces).toHaveLength(0)
    const longList = statusBarSourceForFixture(source, "long-list").workspaces
    expect(longList).toHaveLength(10)
    expect(new Set(longList.map(({ machine }) => machine.id)).size).toBe(10)
    expect(new Set(longList.map(({ machine }) => machine.name)).size).toBe(10)
    expect(source.workspaces).toHaveLength(3)
    expect(source.workspaces.every(({ freshness }) => freshness === "fresh")).toBe(true)
  })

  it("simulates lifecycle actions and hands the resulting snapshot to the application", async () => {
    const user = userEvent.setup()
    const source = applicationSourceForScenario("running")
    const onOpenSilo = vi.fn()
    render(<StatusBarPreview source={source} onOpenSilo={onOpenSilo} />)

    await user.click(screen.getByRole("button", { name: "Start playgrounds" }))
    expect(screen.getByRole("listitem", { name: "playgrounds" })).toHaveAttribute("aria-busy", "true")
    expect(await within(screen.getByRole("listitem", { name: "playgrounds" })).findByText("Running", { exact: true })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Actions for playgrounds" }))
    await user.click(screen.getByRole("menuitem", { name: "Stop…" }))
    await user.click(screen.getByRole("button", { name: "Stop" }))
    expect(screen.getByText("Stopping playgrounds…")).toBeVisible()
    expect(await within(screen.getByRole("listitem", { name: "playgrounds" })).findByText("Stopped", { exact: true })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Actions for dev" }))
    await user.click(screen.getByRole("menuitem", { name: "Restart…" }))
    await user.click(screen.getByRole("button", { name: "Restart" }))
    expect(screen.getByText("Restarting dev…")).toBeVisible()
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Preview feedback" })).toHaveTextContent("Preview: dev restarted."))
    await user.click(screen.getByRole("button", { name: "Open Silo…" }))
    expect(onOpenSilo).toHaveBeenCalledWith(expect.objectContaining({
      workspaces: expect.arrayContaining([
        expect.objectContaining({ machine: expect.objectContaining({ name: "dev" }), state: "running", stateDetail: "Running" }),
        expect.objectContaining({ machine: expect.objectContaining({ name: "playgrounds" }), state: "stopped", stateDetail: "Stopped" }),
      ]),
    }), undefined)
    expect(source.workspaces[0].stateDetail).toBe("Running for 2h 18m")
  })

  it("acknowledges host actions outside the popover and keeps quit local to the preview", async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, "open")
    const close = vi.spyOn(window, "close")
    render(<StatusBarPreview source={applicationSourceForScenario("running")} onOpenSilo={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Open dev in Terminal" }))
    expect(screen.queryByRole("dialog", { name: "Silo" })).not.toBeInTheDocument()
    expect(screen.getByRole("complementary", { name: "Preview feedback" })).toHaveTextContent("Preview: open Terminal in dev.")
    await user.click(screen.getByRole("button", { name: "Silo status bar" }))
    await user.click(screen.getByRole("button", { name: "Quit Silo" }))
    expect(screen.queryByRole("button", { name: "Silo status bar" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Relaunch Silo" }))
    expect(screen.getByRole("button", { name: "Silo status bar" })).toBeVisible()
    expect(screen.getByRole("dialog", { name: "Silo" })).toBeVisible()
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    open.mockRestore()
    close.mockRestore()
  })

  it("starts clean when a fixture changes after a simulated quit", async () => {
    const user = userEvent.setup()
    const source = applicationSourceForScenario("running")
    const onOpenSilo = vi.fn()
    const preview = render(<StatusBarPreview fixtureKey="running" source={source} mode="stale" onOpenSilo={onOpenSilo} />)
    await user.click(screen.getByRole("button", { name: "Retry sandbox status" }))
    expect(screen.queryByRole("button", { name: "Retry sandbox status" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Quit Silo" }))
    preview.rerender(<StatusBarPreview fixtureKey="running" source={source} mode="empty" onOpenSilo={onOpenSilo} />)
    expect(screen.getByRole("button", { name: "Silo status bar" })).toBeVisible()
    expect(screen.getByText("No sandboxes yet")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Relaunch Silo" })).not.toBeInTheDocument()
  })

  it("opens the requested application section with its sandbox filter and changed state", async () => {
    window.history.replaceState(null, "", "?view=status-bar&scenario=running&repository-push=failed")
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Start playgrounds" }))
    await user.click(screen.getByRole("button", { name: "Review push failure for dev, acme/silo" }))

    const navigation = within(screen.getByRole("navigation", { name: "Silo navigation" }))
    expect(navigation.getByRole("button", { name: "Files" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("button", { name: "Remove dev" })).toBeVisible()
    const repositories = within(screen.getByRole("list", { name: "Repositories" }))
    expect(repositories.getByText("acme/silo")).toBeVisible()
    expect(repositories.queryByText("acme/platform-tools")).not.toBeInTheDocument()
    await user.click(navigation.getByRole("button", { name: "Overview" }))
    const playgrounds = within(screen.getByRole("list", { name: "Configured sandboxes" })).getByText("playgrounds").closest("li")!
    expect(within(playgrounds).getByText("Running", { exact: true })).toBeVisible()
    expect(new URL(window.location.href).searchParams.get("view")).toBe("app")
  })

  it("opens runtime repair in the application's existing System issue destination", async () => {
    window.history.replaceState(null, "", "?view=status-bar&scenario=running&system-issue=needed")
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Repair…" }))
    expect(screen.getByRole("region", { name: "System issue" })).toBeVisible()
    expect(screen.queryByRole("main", { name: "Status bar preview" })).not.toBeInTheDocument()
  })
})
