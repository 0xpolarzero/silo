import { createApplicationActionsMock } from "@/test/application-actions"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

import { fixtureLogPage, type LogQuery } from "@/features/application/model/logs"

function renderApplication(scenario: Parameters<typeof applicationSourceForScenario>[0] = "running", source?: ApplicationSource) {
  const actions = createApplicationActionsMock()

  return {
    actions,
    user: userEvent.setup(),
    ...render(<ApplicationPreview source={source ?? applicationSourceForScenario(scenario)} actions={actions} />),
  }
}

function appNavigation() {
  return screen.getByRole("navigation", { name: "Silo navigation" })
}

function appPanel(name: string) {
  return screen.getByRole("region", { name })
}

it("returns to cached logs after visiting another sandbox page", async () => {
  const source = applicationSourceForScenario("running")
  const workspace = source.workspaces[0]
  const queryLogs = vi.fn(async (query: LogQuery) => fixtureLogPage(workspace, query))
  const user = userEvent.setup()
  render(<ApplicationPreview source={source} actions={{ queryLogs }} initialRoute={{ workspace: workspace.machine.name, workspaceSection: "logs" }} />)
  await screen.findByText(/Showing .* matching records/)
  const calls = queryLogs.mock.calls.length
  const sections = within(within(appNavigation()).getByRole("group", { name: "Sandbox sections" }))
  await user.click(sections.getByRole("button", { name: "Files" }))
  await user.click(sections.getByRole("button", { name: "Logs" }))
  expect(screen.getByText(/Showing .* matching records/)).toBeVisible()
  expect(queryLogs).toHaveBeenCalledTimes(calls)
  await user.click(sections.getByRole("button", { name: "All sandboxes" }))
  await user.click(sections.getByRole("button", { name: "Logs" }))
  expect(screen.getByText(/Showing .* matching records/)).toBeVisible()
  expect(queryLogs).toHaveBeenCalledTimes(calls)
})

it("refreshes repositories without toggling the pane and disables the button while loading", async () => {
  let finish!: () => void
  const refreshRepositories = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const user = userEvent.setup()
  render(<ApplicationPreview source={applicationSourceForScenario("running")} actions={{ refreshRepositories }} initialRoute={{ workspaceSection: "files" }} />)
  const button = screen.getByRole("button", { name: "Refresh repositories" })
  await user.click(button)
  expect(refreshRepositories).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  expect(screen.getByRole("button", { name: "Collapse repositories" })).toHaveAttribute("aria-expanded", "true")
  finish()
  await waitFor(() => expect(button).toBeEnabled())
})


it("opens failed activity logs in a diagnostic window and keeps a cleared range cleared", async () => {
  const source = applicationSourceForScenario("running")
  const workspace = source.workspaces[0]
  source.activities = [{ id: "failed-start", category: "sandbox", title: "Start failed", detail: "Runtime failed", occurredAt: "2026-09-18T10:00:00Z", time: "Now", tone: "danger", status: "completed", workspace: workspace.machine.name }]
  const queryLogs = vi.fn(async () => ({ entries: [], nextCursor: null, oldestAvailableTimestamp: null, newestAvailableTimestamp: null, totalMatches: 0, timestampEstimated: false }))
  const user = userEvent.setup()
  render(<ApplicationPreview source={source} actions={{ queryLogs }} initialRoute={{ workspaceSection: "activity" }} />)
  await user.click(screen.getByRole("button", { name: "Show logs" }))
  await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxId: workspace.machine.id, since: "2026-09-18T09:55:00.000Z", until: "2026-09-18T10:05:00.000Z" })))
  await user.click(screen.getByRole("button", { name: /^Remove Date/ }))
  await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ since: undefined, until: undefined })))
  const sections = within(within(appNavigation()).getByRole("group", { name: "Sandbox sections" }))
  await user.click(sections.getByRole("button", { name: "Activity" }))
  await user.click(sections.getByRole("button", { name: "Logs" }))
  await waitFor(() => expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ since: undefined, until: undefined })))
  expect(screen.queryByLabelText("Logs from")).not.toBeInTheDocument()
})


it("shows the recorded time for runtime logs without an embedded timestamp", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const occurredAt = "2026-09-09T19:03:05.952Z"
  source.workspaces[0].logs = [{ line: "[  61.851852] reboot: Power down", occurredAt }]
  render(<ApplicationPreview source={source} initialRoute={{ workspace: "dev", workspaceSection: "logs" }} />)
  const logs = within(await screen.findByRole("table", { name: "Logs" }))
  expect(logs.getByText("[ 61.851852] reboot: Power down")).toBeVisible()
  expect(logs.getByText(new Date(occurredAt).toLocaleTimeString())).toBeVisible()
})


it.each(["add-configuring", "remove-pending"] as const)("ignores property order on unchanged sandboxes during %s", (operation) => {
  const source = structuredClone(applicationSourceForScenario("running", undefined, undefined, operation))
  source.workspaces = source.workspaces.map(workspace => ({
    ...workspace, machine: Object.fromEntries(Object.entries(workspace.machine).reverse()) as typeof workspace.machine,
  }))
  renderApplication("running", source)
  const overview = within(appPanel("Sandboxes"))
  for (const workspace of source.workspaces.filter(({ machine }) => source.sandboxConfigurationOperation?.candidate.machines.some(({ id }) => id === machine.id))) {
    const row = overview.getByText(workspace.machine.name).closest("li") as HTMLElement
    expect(row).not.toHaveAttribute("aria-busy")
    expect(within(row).queryByText("Preparing sandbox configuration.")).not.toBeInTheDocument()
  }
})


it("formats activity dates in the user's locale and timezone", () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const occurredAt = "2026-09-10T09:03:05Z"
  source.activities = [{ ...source.activities[0], occurredAt, time: occurredAt }]
  render(<ApplicationPreview source={source} initialRoute={{ workspaceSection: "activity" }} />)
  expect(screen.getByText(new Date(occurredAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" }))).toBeVisible()
  expect(screen.queryByText(occurredAt)).not.toBeInTheDocument()
})


it("keeps secret edits across navigation and shows pending changes on affected sandboxes", async () => {
  const { user, actions } = renderApplication()
  await user.click(within(appNavigation()).getByRole("button", { name: "Secrets" }))
  await user.click(screen.getByRole("button", { name: "Edit PACKAGE_TOKEN" }))
  const form = within(screen.getByRole("form", { name: "Edit PACKAGE_TOKEN" }))
  await user.click(form.getByRole("combobox", { name: "Add sandbox" }))
  await user.click(screen.getByRole("option", { name: "personal" }))
  await user.clear(form.getByRole("textbox", { name: "Allowed domains" }))
  await user.type(form.getByRole("textbox", { name: "Allowed domains" }), "packages.example.test")
  await user.click(form.getByRole("button", { name: "Save" }))
  expect(actions.saveSecret).toHaveBeenCalledExactlyOnceWith({ operation: "edit", id: "package-token", name: "PACKAGE_TOKEN", workspaces: ["dev", "playgrounds", "personal"], allowedDomains: ["packages.example.test"] })

  await user.click(within(appNavigation()).getByRole("button", { name: "All sandboxes" }))
  expect(screen.getByRole("note", { name: "Secret changes apply on next start for personal" })).toBeVisible()
  await user.click(within(appNavigation()).getByRole("button", { name: "Secrets" }))
  expect(screen.getByLabelText("Allowed domains for PACKAGE_TOKEN")).toHaveTextContent("packages.example.test")
  expect(within(screen.getByRole("group", { name: "Sandboxes for PACKAGE_TOKEN" })).getByText("personal")).toBeVisible()
})


it("applies repeated status-panel routes without resetting the open application", async () => {
  const source = applicationSourceForScenario("running")
  const user = userEvent.setup()
  const { rerender } = render(<ApplicationPreview source={source} />)
  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }))
  rerender(<ApplicationPreview source={source} initialRoute={{ workspace: "dev", workspaceSection: "logs" }} />)
  expect(within(appPanel("Sandboxes")).getByRole("button", { name: "Remove dev" })).toBeVisible()
  expect(within(appNavigation()).getByRole("button", { name: "Logs" })).toHaveAttribute("aria-current", "page")
  rerender(<ApplicationPreview source={source} initialRoute={{ workspace: "playgrounds", workspaceSection: "activity" }} />)
  expect(within(appPanel("Sandboxes")).getByRole("button", { name: "Remove playgrounds" })).toBeVisible()
  expect(within(appPanel("Sandboxes")).queryByRole("button", { name: "Remove dev" })).not.toBeInTheDocument()
  expect(within(appNavigation()).getByRole("button", { name: "Activity" })).toHaveAttribute("aria-current", "page")
  expect(appNavigation()).toHaveAttribute("data-collapsed", "true")
  rerender(<ApplicationPreview source={source} initialRoute={{ workspace: "dev" }} />)
  expect(within(appNavigation()).getByRole("button", { name: "All sandboxes" })).toHaveAttribute("aria-current", "page")
})


it("opens a sandbox detail page and returns to the list with the app's Back control", async () => {
  const { user } = renderApplication("running")
  await user.click(within(appPanel("Sandboxes")).getByRole("button", { name: "Open dev" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesdev")
  expect(within(appPanel("Sandboxes")).queryByRole("list", { name: "Configured sandboxes" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Go back" }))
  expect(within(appPanel("Sandboxes")).getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Go forward" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesdev")
})


it("deep-links into a sandbox detail page and tab from an initial route", () => {
  render(<ApplicationPreview source={applicationSourceForScenario("complete")} initialRoute={{ workspace: "dev", sandboxTab: "checkpoints" }} />)
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesdev")
  expect(screen.getByRole("tab", { name: "Checkpoints" })).toHaveAttribute("aria-selected", "true")
})


it("collapses the sidebar to labelled icons and keeps every destination usable", async () => {
  const { user } = renderApplication()
  const navigation = within(appNavigation())

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }))
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false")
  expect(appNavigation()).toHaveAttribute("data-collapsed", "true")
  expect(navigation.queryByRole("button", { name: "Collapse Sandboxes menu" })).not.toBeInTheDocument()
  expect(navigation.queryByRole("group", { name: "Settings sections" })).not.toBeInTheDocument()
  for (const label of ["All sandboxes", "Files", "Logs", "Network", "Activity", "GitHub", "Secrets", "Settings"]) {
    const button = navigation.getByRole("button", { name: label })
    expect(button.querySelector("svg")).toBeInTheDocument()
    expect(button).toHaveAccessibleName(label)
  }
  await user.click(navigation.getByRole("button", { name: "Settings" }))
  await user.click(navigation.getByRole("button", { name: "Notifications" }))
  expect(within(appPanel("Settings")).getByRole("heading", { name: "Notifications", level: 2 })).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Expand sidebar" }))
  expect(appNavigation()).toHaveAttribute("data-collapsed", "false")
  expect(navigation.getByRole("button", { name: "Notifications" })).toHaveAttribute("aria-current", "page")
})


it("preserves closed sandbox and open settings menus when toggling sidebar width", async () => {
  const { user } = renderApplication()
  const navigation = within(appNavigation())
  await user.click(navigation.getByRole("button", { name: "Collapse Sandboxes menu" }))
  await user.click(navigation.getByRole("button", { name: "Settings" }))

  for (const toggle of ["Collapse sidebar", "Expand sidebar"]) {
    await user.click(screen.getByRole("button", { name: toggle }))
    expect(navigation.queryByRole("group", { name: "Sandbox sections" })).not.toBeInTheDocument()
    expect(navigation.getByRole("group", { name: "Settings sections" })).toBeVisible()
    expect(navigation.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page")
  }
})


it("navigates backward and forward through pages and nested sections, replacing the forward branch after a new visit", async () => {
  const { user } = renderApplication()
  const navigation = within(appNavigation())
  const back = screen.getByRole("button", { name: "Go back" })
  const forward = screen.getByRole("button", { name: "Go forward" })
  expect(back).toBeDisabled()
  expect(forward).toBeDisabled()

  await user.click(navigation.getByRole("button", { name: "Files" }))
  await user.click(navigation.getByRole("button", { name: "GitHub" }))
  await user.click(navigation.getByRole("button", { name: "Settings" }))
  await user.click(navigation.getByRole("button", { name: "Notifications" }))
  await user.click(back)
  expect(within(appPanel("Settings")).getByRole("heading", { name: "Appearance", level: 3 })).toBeVisible()
  await user.click(back)
  expect(appPanel("GitHub")).toBeVisible()
  await user.click(back)
  expect(within(appPanel("Sandboxes")).getByRole("list", { name: "Repositories" })).toBeVisible()
  await user.click(forward)
  expect(appPanel("GitHub")).toBeVisible()
  await user.click(navigation.getByRole("button", { name: "Secrets" }))
  expect(forward).toBeDisabled()
  await user.click(navigation.getByRole("button", { name: "Secrets" }))
  await user.click(back)
  expect(appPanel("GitHub")).toBeVisible()
})


it("keeps busy and warning indicators visible in the collapsed sidebar", async () => {
  const { user } = renderApplication("running", applicationSourceForScenario("running", "connecting", "warning", undefined, undefined, "pushing"))
  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }))
  const navigation = within(appNavigation())
  for (const label of ["Files", "GitHub"]) {
    const button = navigation.getByRole("button", { name: label })
    expect(button).toHaveAttribute("aria-busy", "true")
    const icons = button.querySelectorAll("svg")
    expect(icons).toHaveLength(2)
    expect(icons[0]).not.toHaveAttribute("data-navigation-loading-indicator")
    expect(icons[0]).not.toHaveClass("animate-spin")
    expect(icons[1]).toHaveAttribute("data-navigation-loading-indicator")
    expect(icons[1]).toHaveClass("size-2")
  }
  expect(navigation.getByRole("status", { name: "3 sandboxes need attention" })).toBeInTheDocument()
})


it.each(["past", "future"] as const)("removes a resolved issue from the %s navigation history", async (position) => {
  const application = renderApplication("running", applicationSourceForScenario("running", undefined, undefined, undefined, "checking"))
  const navigation = within(appNavigation())
  await application.user.click(navigation.getByRole("button", { name: "Files" }))
  await application.user.click(navigation.getByRole("button", { name: "System issue" }))
  await application.user.click(navigation.getByRole("button", { name: "GitHub" }))
  const back = screen.getByRole("button", { name: "Go back" })
  const forward = screen.getByRole("button", { name: "Go forward" })
  if (position === "future") {
    await application.user.click(back)
    await application.user.click(back)
  }
  application.rerender(<ApplicationPreview source={applicationSourceForScenario("running")} actions={application.actions} />)
  if (position === "past") {
    await application.user.click(back)
    expect(within(appPanel("Sandboxes")).getByRole("list", { name: "Repositories" })).toBeVisible()
  }
  await application.user.click(forward)
  expect(appPanel("GitHub")).toBeVisible()
  expect(forward).toBeDisabled()
  expect(navigation.queryByRole("button", { name: "System issue" })).not.toBeInTheDocument()
})


it("opens and dismisses commands with either platform shortcut without losing the current page", async () => {
  const { user } = renderApplication()
  await user.click(within(appNavigation()).getByRole("button", { name: "GitHub" }))
  const trigger = screen.getByRole("button", { name: "Search or jump to" })
  for (const shortcut of ["{Meta>}k{/Meta}", "{Control>}k{/Control}"]) {
    await user.keyboard(shortcut)
    const input = screen.getByRole("combobox", { name: "Search commands" })
    expect(input).toHaveFocus()
    expect(input).toHaveValue("")
    await user.type(input, "nothing-matches-this-command")
    expect(screen.getByText("No commands found.")).toBeVisible()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  }
  expect(appPanel("GitHub")).toBeVisible()
})


it("filters commands and opens one sandbox's files using the keyboard", async () => {
  const { user } = renderApplication()
  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.type(screen.getByRole("combobox", { name: "Search commands" }), "dev")
  expect(screen.queryByRole("option", { name: "Sandboxes" })).not.toBeInTheDocument()
  expect(screen.queryByRole("option", { name: "Open playgrounds activity" })).not.toBeInTheDocument()
  await user.keyboard(" files")
  expect(screen.getByRole("option", { name: "Open dev files" })).toBeVisible()
  await user.keyboard("{Enter}")
  expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
  expect(screen.getByRole("list", { name: "Files in dev" })).toBeVisible()
  expect(screen.queryByRole("list", { name: "Files in playgrounds" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Go back" }))
  expect(screen.getByRole("heading", { name: "Sandboxes" })).toBeVisible()
})


it("toggles the menu with Ctrl-K instead of moving the selection", async () => {
  const { user } = renderApplication()
  await user.keyboard("{Control>}k{/Control}")
  expect(screen.getByRole("dialog", { name: "Commands" })).toBeVisible()
  await user.keyboard("{Control>}k{/Control}")
  expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
})


it.each(["Activity", "Files", "Logs", "Network"])("clears the sandbox filter when the general %s command follows a scoped command", async (section) => {
  const { user } = renderApplication()
  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.click(screen.getByRole("option", { name: `Open dev ${section.toLowerCase()}` }))
  expect(screen.getByRole("button", { name: "Remove dev" })).toBeVisible()
  if (section === "Activity") expect(screen.queryByText("Stop verified")).not.toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Search or jump to" }))
  await user.click(screen.getByRole("option", { name: section }))
  const filters = within(screen.getByRole("group", { name: "Sandbox filters" }))
  expect(filters.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument()
  expect(filters.getByRole("button", { name: "Clear" })).toBeDisabled()
  if (section === "Activity") expect(screen.getByText("Stop verified")).toBeVisible()
})


it("dispatches available sandbox commands and removes them when status becomes stale", async () => {
  const application = renderApplication()
  await application.user.keyboard("{Meta>}k{/Meta}")
  const input = screen.getByRole("combobox", { name: "Search commands" })
  await application.user.type(input, "dev terminal")
  await application.user.keyboard("{Enter}")
  expect(application.actions.openTerminal).toHaveBeenCalledExactlyOnceWith("dev")
  await application.user.keyboard("{Control>}k{/Control}")
  await application.user.type(screen.getByRole("combobox", { name: "Search commands" }), "start playgrounds")
  await application.user.keyboard("{Enter}")
  expect(application.actions.startWorkspace).toHaveBeenCalledExactlyOnceWith("playgrounds")
  await application.user.keyboard("{Meta>}k{/Meta}")
  const source = applicationSourceForScenario("running")
  application.rerender(<ApplicationPreview source={{ ...source, workspaces: source.workspaces.map((workspace) => ({ ...workspace, freshness: "stale" })) }} actions={application.actions} />)
  expect(screen.queryByRole("option", { name: "Start playgrounds" })).not.toBeInTheDocument()
  expect(screen.queryByRole("option", { name: /Open dev in/ })).not.toBeInTheDocument()
  expect(screen.getByRole("option", { name: "Open dev logs" })).toBeVisible()
})


it("runs an import to completion and reflects the new stopped sandbox", async () => {
  vi.useFakeTimers()
  const application = renderApplication()
  try {
    const overviewNav = within(within(appNavigation()).getByRole("group", { name: "Sandbox sections" })).getByRole("button", { name: "All sandboxes" })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Import sandbox…" }))
    await act(async () => { await Promise.resolve() })
    // The import review popover opens anchored to Add; the import starts from it, then continues as a toast.
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await act(async () => { await Promise.resolve() })
    expect(overviewNav).toHaveAttribute("aria-busy", "true")
    for (let step = 0; step < 4; step += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(overviewNav).not.toHaveAttribute("aria-busy", "true")
    const overview = within(appPanel("Sandboxes"))
    expect(overview.getByRole("button", { name: "Stop dev" })).toBeEnabled()
    expect(overview.getByRole("button", { name: "Start dev-imported" })).toBeEnabled()
    expect(application.actions.stopWorkspace).not.toHaveBeenCalled()
    // Completion is a background toast, not an inline panel.
    expect(screen.queryByRole("region", { name: "Import sandbox" })).not.toBeInTheDocument()
    expect(screen.getByText("Imported dev-imported")).toBeInTheDocument()
  } finally {
    application.unmount()
    vi.useRealTimers()
  }
})


it("opens on the nested sandbox Overview with compact navigation", () => {
  renderApplication()

  const navigation = appNavigation()
  const primaryItems = [...navigation.querySelectorAll<HTMLElement>("[data-navigation-level='primary']")]
  expect(primaryItems).toEqual(["Sandboxes", "GitHub", "Secrets", "Settings"].map(name => within(navigation).getByRole("button", { name })))
  for (const item of primaryItems) expect(item).toHaveClass("flex-none", "w-full")

  expect(within(navigation).getByRole("button", { name: "Sandboxes" })).toHaveAttribute("aria-current", "page")
  const sandboxSections = within(navigation).getByRole("group", { name: "Sandbox sections" })
  expect(within(sandboxSections).getAllByRole("button")).toEqual(["All sandboxes", "Files", "Logs", "Network", "Activity"].map(name => within(sandboxSections).getByRole("button", { name })))
  expect(within(sandboxSections).getByRole("button", { name: "All sandboxes" })).toHaveAttribute("aria-current", "page")
  expect(sandboxSections).toHaveClass("sidebar-subnav")

  const overview = within(appPanel("Sandboxes"))
  expect(overview.queryByRole("heading", { name: "All sandboxes" })).not.toBeInTheDocument()
  expect(overview.queryByText(/Updated just now/)).not.toBeInTheDocument()
  expect(overview.getByRole("heading", { name: "Sandboxes" })).toBeVisible()
  expect(overview.getByText("3 sandboxes · 3 on this computer · 0 on other computers · 0 SSH hosts")).toBeVisible()
  expect(overview.getByRole("button", { name: "Add" })).toBeVisible()
  const sandboxList = overview.getByRole("list", { name: "Configured sandboxes" })
  expect(sandboxList).toBeVisible()
  expect(appPanel("Sandboxes")).toHaveClass("h-full", "min-h-0", "overflow-hidden")
  expect(appPanel("Sandboxes").parentElement).toHaveClass("overflow-hidden")
  expect(sandboxList.closest('[data-slot="scroll-area"]')).toHaveClass("max-h-full", "min-h-0")
  expect(sandboxList.closest('[data-slot="scroll-area"]')).not.toHaveClass("flex-1")
  expect(screen.queryByRole("group", { name: "Settings sections" })).not.toBeInTheDocument()
})


it.each([
  ["warning", "3 sandboxes have warnings", "3"],
  ["error", "3 sandboxes have errors", "3"],
] as const)("counts %s sandboxes next to Overview", (mode, label, count) => {
  renderApplication("running", applicationSourceForScenario("running", undefined, mode))

  const overview = within(within(appNavigation()).getByRole("group", { name: "Sandbox sections" })).getByRole("button", { name: /All sandboxes/ })
  expect(within(overview).getByRole("status", { name: label })).toHaveTextContent(count)
})


it("shows spinners on sidebar destinations that own active work", () => {
  const cases: Array<{
    label: string
    source: ApplicationSource
    section?: "workspace"
  }> = [
    { label: "All sandboxes", source: applicationSourceForScenario("running", undefined, "starting"), section: "workspace" },
    { label: "All sandboxes", source: applicationSourceForScenario("running", undefined, undefined, "add-verifying"), section: "workspace" },
    { label: "Files", source: applicationSourceForScenario("running", undefined, undefined, undefined, undefined, "pushing"), section: "workspace" },
    { label: "Files", source: applicationSourceForScenario("running", undefined, undefined, undefined, undefined, undefined, "git-live"), section: "workspace" },
    { label: "GitHub", source: applicationSourceForScenario("running", "connecting") },
    { label: "GitHub", source: applicationSourceForScenario("running", "connected", undefined, undefined, undefined, undefined, undefined, 0, "applying") },
    { label: "Secrets", source: applicationSourceForScenario("running", undefined, undefined, undefined, undefined, undefined, "secrets-live") },
    { label: "All sandboxes", source: applicationSourceForScenario("running", undefined, undefined, undefined, undefined, undefined, "backup-live"), section: "workspace" },
    { label: "System issue", source: applicationSourceForScenario("running", undefined, undefined, undefined, "checking") },
  ]

  for (const { label, source, section } of cases) {
    const application = renderApplication("running", source)
    const navigation = within(appNavigation())
    const button = section === "workspace"
      ? within(navigation.getByRole("group", { name: "Sandbox sections" })).getByRole("button", { name: label })
      : navigation.getByRole("button", { name: label })

    expect(button).toHaveAttribute("aria-busy", "true")
    const icons = button.querySelectorAll("svg")
    expect(icons).toHaveLength(2)
    expect(icons[0]).not.toHaveClass("animate-spin")
    expect(icons[1]).toHaveAttribute("data-navigation-loading-indicator")
    expect(icons[1]).toHaveClass("animate-spin")
    application.unmount()
  }
})


it("keeps Activity static while background work is running", () => {
  renderApplication("running", applicationSourceForScenario("running", undefined, undefined, undefined, undefined, undefined, "backup-live"))
  const activity = within(appNavigation()).getByRole("button", { name: "Activity" })
  expect(activity).not.toHaveAttribute("aria-busy")
  expect(activity.querySelector("[data-navigation-loading-indicator]")).toBeNull()
})


it("keeps idle and completed sidebar destinations static", () => {
  const source = applicationSourceForScenario("running", "connected", undefined, undefined, undefined, "succeeded", "backup-live", 4, "succeeded")
  renderApplication("running", source)
  const navigation = within(appNavigation())
  const sandboxSections = within(navigation.getByRole("group", { name: "Sandbox sections" }))

  for (const label of ["All sandboxes", "Files", "Logs", "Network", "Activity"]) {
    expect(sandboxSections.getByRole("button", { name: label })).not.toHaveAttribute("aria-busy")
  }
  for (const label of ["GitHub", "Secrets", "Settings"]) {
    expect(navigation.getByRole("button", { name: label })).not.toHaveAttribute("aria-busy")
  }
})


it("lets each caret expand or collapse without navigating", async () => {
  const { user } = renderApplication()
  const navigation = within(appNavigation())
  const sandboxes = navigation.getByRole("button", { name: "Sandboxes" })

  await user.click(navigation.getByRole("button", { name: "Collapse Sandboxes menu" }))
  expect(navigation.queryByRole("group", { name: "Sandbox sections" })).not.toBeInTheDocument()
  expect(sandboxes).toHaveAttribute("aria-current", "page")
  expect(within(appPanel("Sandboxes")).getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
  const sandboxCaret = navigation.getByRole("button", { name: "Expand Sandboxes menu" })
  expect(sandboxCaret).toBeVisible()
  expect(sandboxCaret.querySelector("svg")).toBeVisible()

  const settingsCaret = navigation.getByRole("button", { name: "Expand Settings menu" })
  expect(settingsCaret).toBeVisible()
  expect(settingsCaret.querySelector("svg")).toBeVisible()
  await user.click(settingsCaret)
  expect(navigation.getByRole("group", { name: "Settings sections" })).toBeVisible()
  expect(sandboxes).toHaveAttribute("aria-current", "page")
  expect(navigation.getByRole("button", { name: "Settings" })).not.toHaveAttribute("aria-current")

  await user.click(within(navigation.getByRole("group", { name: "Settings sections" })).getByRole("button", { name: "Notifications" }))
  expect(within(appPanel("Settings")).getByRole("heading", { name: "Notifications", level: 2 })).toBeVisible()

  await user.click(navigation.getByRole("button", { name: "Collapse Settings menu" }))
  expect(navigation.queryByRole("group", { name: "Settings sections" })).not.toBeInTheDocument()
  expect(within(appPanel("Settings")).getByRole("heading", { name: "Notifications", level: 2 })).toBeVisible()
})


it("fits a new sandbox to the capacity this computer reports (I-24)", async () => {
  const source = { ...applicationSourceForScenario("running"), hostCapacity: { logicalCpus: 8, physicalMemoryBytes: 16 * 1024 ** 3, maxMemoryGib: 16 } }
  const { user } = renderApplication("running", source)
  const panel = within(appPanel("Sandboxes"))
  await user.click(panel.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  expect(panel.getByRole("combobox", { name: "CPUs ceiling" })).toHaveValue("8")
  expect(panel.getByRole("combobox", { name: "Memory ceiling" })).toHaveValue("16")
  expect(panel.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
})


it("keeps an unsaved sandbox edit while visiting another section (I-37)", async () => {
  const { user } = renderApplication()
  const sandboxSections = within(within(appNavigation()).getByRole("group", { name: "Sandbox sections" }))
  await user.click(screen.getByRole("button", { name: "More actions for dev" }))
  await user.click(screen.getByRole("menuitem", { name: "Edit dev" }))
  await user.selectOptions(within(appPanel("Sandboxes")).getByRole("combobox", { name: "CPUs" }), "4")
  await user.click(sandboxSections.getByRole("button", { name: "Files" }))
  expect(within(appPanel("Sandboxes")).queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
  await user.click(sandboxSections.getByRole("button", { name: "All sandboxes" }))
  expect(within(appPanel("Sandboxes")).getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
})


it.each(["local", "office", "lab"])("notification routes keep the next action on %s despite duplicate names and a rename", async (owner) => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const local = source.workspaces[0]
  const vmId = local.machine.id
  source.remoteComputers = ["office", "lab"].map(id => ({ id, name: id, address: `user@${id}`, connected: true }))
  for (const computer of source.remoteComputers) {
    source.workspaces.push({
      ...structuredClone(local),
      computer: { ...computer, vmId },
      machine: { ...local.machine, id: `silo-remote:${computer.id}:${vmId}` },
    })
  }
  const target = owner === "local" ? vmId : `silo-remote:${owner}:${vmId}`
  const openTerminal = vi.fn()
  const user = userEvent.setup()
  const { rerender } = render(<ApplicationPreview source={source} actions={{ openTerminal }} initialRoute={{ workspace: target }} />)
  await user.click(screen.getByRole("button", { name: /^Open .* in Terminal$/ }))
  expect(openTerminal).toHaveBeenLastCalledWith(owner === "local" ? local.machine.name : target)
  const renamed = structuredClone(source)
  renamed.workspaces.find(workspace => workspace.machine.id === target)!.machine.name = "renamed"
  rerender(<ApplicationPreview source={renamed} actions={{ openTerminal }} initialRoute={{ workspace: target }} />)
  await user.click(screen.getByRole("button", { name: /^Open .* in Terminal$/ }))
  expect(openTerminal).toHaveBeenLastCalledWith(owner === "local" ? "renamed" : target)
})
