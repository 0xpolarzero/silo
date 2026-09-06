import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { ApplicationSource } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { StatusBar } from "./status-bar"
import type { StatusBarActions } from "./status-bar-types"

function setup(overrides: Partial<ApplicationSource> = {}) {
  const source = { ...applicationSourceForScenario("complete"), activities: [], ...overrides }
  const actions: StatusBarActions = {
    openSilo: vi.fn(), quit: vi.fn(), refresh: vi.fn(),
    startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(),
    openTerminal: vi.fn(), openEditor: vi.fn(), openSite: vi.fn(),
  }
  return { user: userEvent.setup(), source, actions, ...render(<StatusBar source={source} actions={actions} defaultOpen />) }
}

describe("status bar", () => {
  it("shows shared sandbox status and opens the configured terminal, dismissing the popover", async () => {
    const { user, actions } = setup()
    expect(screen.getByRole("dialog", { name: "Silo" })).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Silo" })).toHaveFocus()
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View error details" })).not.toBeInTheDocument()
    expect(screen.getByRole("note", { name: "Restart required for dev" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open dev in Terminal" }))
    expect(actions.openTerminal).toHaveBeenCalledWith("dev")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Silo status bar" })).toHaveFocus()
  })

  it("requires a deliberate confirmation before stop and rechecks availability", async () => {
    const { user, actions, source, rerender } = setup()
    await user.click(screen.getByRole("button", { name: "Actions for dev" }))
    await user.click(screen.getByRole("menuitem", { name: "Stop…" }))
    const confirmation = screen.getByRole("group", { name: "Stop dev?" })
    expect(actions.stopWorkspace).not.toHaveBeenCalled()
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("group", { name: "Stop dev?" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Actions for dev" }))
    await user.click(screen.getByRole("menuitem", { name: "Stop…" }))
    const stale = { ...source, workspaces: source.workspaces.map((workspace) => ({ ...workspace, freshness: "stale" as const })) }
    rerender(<StatusBar source={stale} actions={actions} defaultOpen />)
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled()
    rerender(<StatusBar source={source} actions={actions} defaultOpen />)
    await user.click(screen.getByRole("button", { name: "Stop" }))
    expect(actions.stopWorkspace).toHaveBeenCalledExactlyOnceWith("dev")
  })

  it("blocks terminal and lifecycle actions for stale status and offers retry", async () => {
    const source = applicationSourceForScenario("complete")
    const { user, actions } = setup({ workspaces: source.workspaces.map((workspace) => ({ ...workspace, freshness: "stale" })) })
    expect(screen.getByRole("listitem", { name: "dev" })).toHaveTextContent("Last known status")
    expect(screen.queryByRole("button", { name: "Open dev in Terminal" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry dev status" }))
    expect(actions.refresh).toHaveBeenCalledOnce()
    await user.click(screen.getByRole("button", { name: "Actions for dev" }))
    expect(screen.getByRole("menuitem", { name: "Open in Terminal" })).toHaveAttribute("data-disabled")
    expect(screen.getByRole("menuitem", { name: "Restart…" })).toHaveAttribute("data-disabled")
  })

  it("opens repair in the app and prevents actions while repair is pending", async () => {
    const { user, actions } = setup({ runtimeRepair: { status: "needed", reason: "Runtime not verified" } })
    expect(screen.getByText("Silo needs repair")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open dev in Terminal" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^See logs for / })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Repair…" }))
    expect(actions.openSilo).toHaveBeenCalledWith({ tab: "system" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("explains a failed configuration for a sandbox that is not in the committed list", async () => {
    const fixture = applicationSourceForScenario("running", undefined, undefined, "workspace-error")
    const { user, actions } = setup({ sandboxConfigurationOperation: fixture.sandboxConfigurationOperation })
    expect(screen.queryByRole("listitem", { name: "scratch" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View error details" })).not.toBeInTheDocument()
    const issue = screen.getByRole("alert", { name: "Sandbox changes failed" })
    expect(issue).toHaveTextContent("Networking failed for 'scratch'.")
    await user.click(within(issue).getByRole("button", { name: "Review sandbox changes" }))
    expect(actions.openSilo).toHaveBeenCalledWith({ workspaceSection: "overview" })
  })

  it("shows a failed push beside its details action and clears it when the source resolves", async () => {
    const operation = { workspace: "dev", repositoryPath: "acme/silo", commitCount: 2, status: "failed" as const, message: "The remote branch changed." }
    const { user, actions, source, rerender } = setup({ repositoryPushOperations: [operation] })
    const issue = screen.getByRole("alert", { name: "Push failed · dev" })
    expect(issue).toHaveTextContent("acme/silo · The remote branch changed.")
    expect(screen.queryByRole("button", { name: "View error details" })).not.toBeInTheDocument()
    await user.click(within(issue).getByRole("button", { name: "Review push failure for dev, acme/silo" }))
    expect(actions.openSilo).toHaveBeenCalledWith({ workspace: "dev", workspaceSection: "files" })
    rerender(<StatusBar source={{ ...source, repositoryPushOperations: [{ ...operation, status: "succeeded" }] }} actions={actions} defaultOpen />)
    await user.click(screen.getByRole("button", { name: "Silo status bar" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the machine icon during progress and blocks repeated actions", () => {
    const source = applicationSourceForScenario("complete")
    setup({ workspaces: source.workspaces.map((workspace) => ({ ...workspace, state: "starting", stateDetail: "Starting…" })) })
    const row = screen.getByRole("listitem", { name: "dev" })
    expect(row).toHaveAttribute("aria-busy", "true")
    expect(row.querySelector(".lucide-monitor")).toBeInTheDocument()
    expect(row.querySelector(".animate-spin")).toBeInTheDocument()
    expect(within(row).queryByRole("button", { name: "Start dev" })).not.toBeInTheDocument()
  })

  it("navigates folders, filters within the current folder and opens the exact path", async () => {
    const { user, actions } = setup()
    await user.click(screen.getByRole("button", { name: "Open dev in Visual Studio Code" }))
    expect(screen.queryByText(".gitconfig")).not.toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Filter folders" }), "missing")
    expect(screen.getByRole("status")).toHaveTextContent("No matching folders")
    await user.clear(screen.getByRole("textbox", { name: "Filter folders" }))
    await user.click(screen.getByRole("button", { name: "projects" }))
    await user.click(screen.getByRole("button", { name: "silo" }))
    await user.click(screen.getByRole("button", { name: "Open in Visual Studio Code" }))
    expect(actions.openEditor).toHaveBeenCalledWith("dev", "/workspace/projects/silo")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("supports keyboard navigation to the editor picker", async () => {
    const { user } = setup()
    screen.getByRole("button", { name: "Actions for dev" }).focus()
    await user.keyboard("{Enter}")
    expect(screen.queryByRole("menuitem", { name: "Files" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Open Silo…" })).not.toBeInTheDocument()
    await user.keyboard("{End}{ArrowUp}{Enter}")
    expect(screen.getByRole("heading", { name: "dev folders" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to sandboxes" })).toHaveFocus()
  })

  it("offers only listening sites in numeric order and opens the selected port", async () => {
    const source = applicationSourceForScenario("complete")
    const { user, actions } = setup({ workspaces: source.workspaces.map((workspace) => ({ ...workspace, ports: [{ port: 8080, listening: true }, { port: 3000, listening: true }, { port: 5173, listening: false }] })) })
    await user.click(screen.getByRole("button", { name: "Actions for dev" }))
    screen.getByRole("menuitem", { name: "Open site" }).focus()
    await user.keyboard("{ArrowRight}")
    const ports = screen.getAllByRole("menuitem", { name: /^Port / })
    expect(ports.map((port) => port.textContent)).toEqual(["Port 3000", "Port 8080"])
    expect(screen.queryByRole("menuitem", { name: "Port 5173" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: "Port 8080" }))
    expect(actions.openSite).toHaveBeenCalledWith("dev", 8080)
  })

  it("copies the base URL without a port and keeps copy feedback in the site menu", async () => {
    const { user, actions } = setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    await user.click(screen.getByRole("button", { name: "Actions for dev" }))
    screen.getByRole("menuitem", { name: "Open site" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(screen.queryByRole("menuitem", { name: "Choose port…" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: "Copy base URL" }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith("http://dev.silo.test")
    expect(screen.getByRole("menuitem", { name: "Base URL copied" })).toHaveTextContent("Copied")
    expect(actions.openSilo).not.toHaveBeenCalled()
    expect(actions.openSite).not.toHaveBeenCalled()
    writeText.mockRestore()
  })

  it("lets the user retry a failed URL copy with the keyboard", async () => {
    const { user } = setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard unavailable")).mockResolvedValue(undefined)
    await user.click(screen.getByRole("button", { name: "Actions for dev" }))
    screen.getByRole("menuitem", { name: "Open site" }).focus()
    await user.keyboard("{ArrowRight}{End}{Enter}")
    expect(screen.getByRole("menuitem", { name: "Couldn't copy base URL" })).toHaveTextContent("Copy failed")
    await user.keyboard("{Enter}")
    expect(writeText).toHaveBeenNthCalledWith(2, "http://dev.silo.test")
    expect(screen.getByRole("menuitem", { name: "Base URL copied" })).toHaveFocus()
    writeText.mockRestore()
  })

  it("supports escape dismissal and an empty sandbox list", async () => {
    const { user, actions } = setup({ workspaces: [] })
    expect(screen.getByText("No sandboxes yet")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Silo status bar" }))
    await user.click(screen.getByRole("button", { name: "Quit Silo" }))
    expect(actions.quit).toHaveBeenCalledOnce()
  })
})
