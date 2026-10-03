import { render, screen, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { useRepositoryPushToasts } from "../components/use-repository-push-toasts"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import { remoteWorkspaceTarget } from "../model/connections"
import { OverviewPage } from "./overview-page"

const actions = {} as ApplicationActions
const onPush = vi.fn()
const onDismiss = vi.fn()
const onMachinesChange = vi.fn()

function Host({ source }: { source: ApplicationSource }) {
  useRepositoryPushToasts(source.repositoryPushOperations ?? [], { onPush, onDismiss })
  return <><OverviewPage source={source} actions={actions} onMachinesChange={onMachinesChange} /><Toaster /></>
}

it.each(["failed", "succeeded"] as const)("removes a remote %s push notification on deletion while preserving a same-named device's notification", async (status) => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const local = source.workspaces.find(workspace => workspace.machine.kind === "vm")!
  const remote = {
    ...structuredClone(local),
    machine: { ...local.machine, id: remoteWorkspaceTarget("office", "remote-vm") },
    device: { id: "office", vmId: "remote-vm", name: "Office", address: "office.test", connected: true },
  }
  source.workspaces = [local, remote]
  const push = { workspace: remote.machine.id, repositoryPath: "/workspace/remote-repo", commitCount: 1, target: { repository: "acme/silo", branch: "main", commit: "a".repeat(40) } }
  source.repositoryPushOperations = [
    { ...push, status: "pushing" },
    { ...push, workspace: local.machine.name, repositoryPath: "/workspace/local-repo", status: "pushing" },
  ]
  const view = render(<Host source={source} />)
  view.rerender(<Host source={{ ...source, repositoryPushOperations: source.repositoryPushOperations.map(operation => ({ ...operation, status, message: "Push rejected" })) }} />)
  const remoteTitle = status === "failed" ? "Push failed · remote-repo" : "Pushed 1 commit · remote-repo"
  const localTitle = status === "failed" ? "Push failed · local-repo" : "Pushed 1 commit · local-repo"
  expect(await screen.findByText(remoteTitle)).toBeInTheDocument()
  expect(await screen.findByText(localTitle)).toBeInTheDocument()
  view.rerender(<Host source={{ ...source, workspaces: [local], repositoryPushOperations: [] }} />)
  await waitFor(() => expect(screen.queryByText(remoteTitle)).not.toBeInTheDocument())
  expect(screen.getByText(localTitle)).toBeInTheDocument()
})
