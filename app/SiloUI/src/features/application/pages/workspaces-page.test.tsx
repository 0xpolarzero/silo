import { render, screen, within } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationActivity } from "../model/application-source"
import { createDirectoryStore } from "../model/directory-store"
import { workspaceTarget } from "../model/remote-computers"
import { WorkspacesPage } from "./workspaces-page"

function activity(id: string, workspace: string): ApplicationActivity {
  return { id, category: "sandbox", title: `Event ${id}`, detail: "", occurredAt: "2026-09-29T10:00:00.000Z", time: "10:00", tone: "danger", status: "completed", workspace }
}

function renderActivity(selectedWorkspaceIds: ReadonlySet<string>) {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const kept = source.workspaces[0]
  const activities = [activity("deleted", "removed-sandbox"), activity("kept", workspaceTarget(kept))]
  render(<WorkspacesPage
    section="activity" workspaces={source.workspaces} activities={activities} selectedWorkspaceIds={selectedWorkspaceIds}
    networkActions={{} as ApplicationActions} onSectionChange={vi.fn()} editor="Editor" onOpenEditor={vi.fn()}
    directoryStore={createDirectoryStore(vi.fn())} active logQuery="" repositoryPushOperations={[]} browser="Browser"
    onWorkspaceFilterChange={vi.fn()} onLogQueryChange={vi.fn()} onPushRepository={vi.fn()} onDismissRepositoryPush={vi.fn()}
  />)
  return kept
}

it("keeps a deleted sandbox's activity when no sandbox filter is selected", () => {
  renderActivity(new Set())
  const list = screen.getByRole("list", { name: "Recent activity" })
  expect(within(list).getByText("Event deleted")).toBeVisible()
  expect(within(list).getByLabelText("Sandbox: removed-sandbox")).toBeVisible()
  expect(within(list).getByText("Event kept")).toBeVisible()
})

it("hides other sandboxes' activity when a sandbox filter is selected", () => {
  const source = applicationSourceForScenario("complete")
  renderActivity(new Set([source.workspaces[0].machine.id]))
  const list = screen.getByRole("list", { name: "Recent activity" })
  expect(within(list).queryByText("Event deleted")).not.toBeInTheDocument()
  expect(within(list).getByText("Event kept")).toBeVisible()
})
