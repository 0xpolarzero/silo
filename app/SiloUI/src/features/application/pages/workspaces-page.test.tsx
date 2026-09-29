import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationActivity, ApplicationSource } from "../model/application-source"
import { createDirectoryStore, type DirectoryPage } from "../model/directory-store"
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
    source={source} section="activity" workspaces={source.workspaces} activities={activities} selectedWorkspaceIds={selectedWorkspaceIds}
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

function renderFiles(source: ApplicationSource, onPushRepository = vi.fn()) {
  render(<WorkspacesPage
    source={source} section="files" workspaces={source.workspaces} activities={[]} selectedWorkspaceIds={new Set()}
    networkActions={{} as ApplicationActions} onSectionChange={vi.fn()} editor="Editor" onOpenEditor={vi.fn()}
    directoryStore={createDirectoryStore(() => new Promise<DirectoryPage>(() => {}))} active logQuery="" repositoryPushOperations={[]} browser="Browser"
    onWorkspaceFilterChange={vi.fn()} onLogQueryChange={vi.fn()} onPushRepository={onPushRepository} onDismissRepositoryPush={vi.fn()}
  />)
  return onPushRepository
}

function filesSource() {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.repositoryPushOperations = []
  return source
}

it("names each Push button by repository and sandbox and enables it only for an available sandbox", async () => {
  const source = filesSource()
  const playgrounds = source.workspaces.find(({ machine }) => machine.name === "playgrounds")!
  playgrounds.state = "stopped"
  playgrounds.repositories = [{ ...playgrounds.repositories[0], path: "acme/silo", ahead: 2 }]
  const onPush = renderFiles(source)
  const repositories = within(screen.getByRole("list", { name: "Repositories" }))
  const running = repositories.getByRole("button", { name: "Push 2 commits for acme/silo in dev" })
  expect(running).toBeEnabled()
  expect(repositories.getByRole("button", { name: "Push 2 commits for acme/silo in playgrounds" })).toBeDisabled()
  await userEvent.setup().click(running)
  expect(onPush).toHaveBeenCalledWith("dev", "acme/silo", 2)
})

it("disables Push while the sandbox is stale", () => {
  const source = filesSource()
  source.workspaces.find(({ machine }) => machine.name === "dev")!.freshness = "stale"
  renderFiles(source)
  expect(screen.getByRole("button", { name: "Push 2 commits for acme/silo in dev" })).toBeDisabled()
})

it("names a remote sandbox's Push button by its computer", () => {
  const source = filesSource()
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  dev.computer = { id: "office", name: "Office Mac", address: "office.local", connected: true, vmId: "remote-dev" }
  renderFiles(source)
  expect(screen.getByRole("button", { name: "Push 2 commits for acme/silo in dev on Office Mac" })).toBeEnabled()
})
