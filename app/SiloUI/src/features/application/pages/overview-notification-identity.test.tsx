import { act, render, screen, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import type { ApplicationSource } from "../model/application-source"
import { showBackendNotice } from "../model/use-backend-notices"
import { OverviewPage } from "./overview-page"

it.each(["local", "remote"])("deleting the %s sandbox clears only its backend notification despite identical names", async owner => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const local = source.workspaces[0]
  const remote = {
    ...structuredClone(local),
    machine: { ...local.machine, id: `silo-remote:office:${local.machine.id}` },
    computer: { id: "office", vmId: local.machine.id, name: "Office", address: "office.test", connected: true },
  }
  source.workspaces = [local, remote]
  const actions = createApplicationActionsMock()
  const onMachinesChange = vi.fn()
  const view = (current: ApplicationSource) => <><Toaster /><OverviewPage source={current} actions={actions} onMachinesChange={onMachinesChange} /></>
  const { rerender } = render(view(source))
  act(() => {
    for (const [kind, workspace] of [["local", local], ["remote", remote]] as const) {
      showBackendNotice({ category: "failures", key: `backend-${kind}`, title: `${kind} failure`, body: "Start failed", sandbox: { id: workspace.machine.id, name: workspace.machine.name } })
    }
  })
  expect(await screen.findByText("local failure")).toBeVisible()
  expect(await screen.findByText("remote failure")).toBeVisible()
  const remaining = owner === "local" ? remote : local
  rerender(view({ ...source, workspaces: [remaining] }))
  await waitFor(() => expect(screen.queryByText(`${owner} failure`)).not.toBeInTheDocument())
  expect(screen.getByText(`${owner === "local" ? "remote" : "local"} failure`)).toBeVisible()
})
