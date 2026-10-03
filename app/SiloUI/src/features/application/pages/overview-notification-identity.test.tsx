import { act, render, screen, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"

import { showOperationFailure } from "@/lib/operation-toast"
import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import type { ApplicationSource } from "../model/application-source"
import { showBackendNotice } from "../model/use-backend-notices"
import { OverviewPage } from "./overview-page"

it.each(["local", "remote"])("deleting the %s computer clears only its backend notification despite identical names", async owner => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const local = source.computers[0]
  const remote = {
    ...structuredClone(local),
    configuration: { ...local.configuration, id: `silo-remote:office:${local.configuration.id}` },
    device: { id: "office", computerId: local.configuration.id, name: "Office", address: "office.test", connected: true },
  }
  source.computers = [local, remote]
  const actions = createApplicationActionsMock()
  const onConfigurationsChange = vi.fn()
  const view = (current: ApplicationSource) => <><Toaster /><OverviewPage source={current} actions={actions} onConfigurationsChange={onConfigurationsChange} /></>
  const { rerender } = render(view(source))
  act(() => {
    for (const [kind, computer] of [["local", local], ["remote", remote]] as const) {
      showBackendNotice({ category: "failures", key: `backend-${kind}`, title: `${kind} failure`, body: "Start failed", computer: { id: computer.configuration.id, name: computer.configuration.name } })
    }
  })
  expect(await screen.findByText("local failure")).toBeVisible()
  expect(await screen.findByText("remote failure")).toBeVisible()
  const remaining = owner === "local" ? remote : local
  rerender(view({ ...source, computers: [remaining] }))
  await waitFor(() => expect(screen.queryByText(`${owner} failure`)).not.toBeInTheDocument())
  expect(screen.getByText(`${owner === "local" ? "remote" : "local"} failure`)).toBeVisible()
})

it("a recreated computer keeps its own frontend notification and clears its predecessor's", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const original = source.computers[0]
  const replacement = { ...original, configuration: { ...original.configuration, id: "replacement-vm" } }
  source.computers = [original]
  const actions = createApplicationActionsMock()
  const onConfigurationsChange = vi.fn()
  const view = (current: ApplicationSource) => <><Toaster /><OverviewPage source={current} actions={actions} onConfigurationsChange={onConfigurationsChange} /></>
  const { rerender } = render(view(source))
  act(() => {
    for (const [kind, computer] of [["original", original], ["replacement", replacement]] as const) {
      showOperationFailure(`frontend-${kind}`, `${kind} failure`, { computer: computer.configuration.name, noticeComputer: { id: computer.configuration.id, name: computer.configuration.name }, native: false })
    }
  })
  expect(await screen.findByText("original failure")).toBeVisible()
  expect(await screen.findByText("replacement failure")).toBeVisible()
  rerender(view({ ...source, computers: [replacement] }))
  await waitFor(() => expect(screen.queryByText("original failure")).not.toBeInTheDocument())
  expect(screen.getByText("replacement failure")).toBeVisible()
})
