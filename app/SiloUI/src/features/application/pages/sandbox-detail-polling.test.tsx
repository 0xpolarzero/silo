import { ComputerUseProvider } from "@/desktop/computer-use-provider"
import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createComputerUseBridge } from "@/desktop/computer-use-bridge"
import { createFixtureComputerUseBackend, fixtureDesktopState } from "@/fixtures/computer-use"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { OverviewPage } from "./overview-page"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it("stops refreshing the sandbox page's ports while the Sandboxes page is hidden", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  const refreshNetwork = vi.fn(async () => {})
  const actions = { refreshNetwork } as unknown as ApplicationActions
  const page = (active: boolean) => <OverviewPage active={active} source={source} actions={actions} onMachinesChange={vi.fn()} selectedSandboxId={dev.machine.id} sandboxTab="overview" onOpenSandbox={vi.fn()} onCloseSandbox={vi.fn()} onSelectSandboxTab={vi.fn()} />
  const view = render(page(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(refreshNetwork).toHaveBeenCalled()

  view.rerender(page(false))
  refreshNetwork.mockClear()
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(refreshNetwork).not.toHaveBeenCalled()
})

it("stops computer-use reads while the sandbox page is hidden and refreshes on return", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const dev = source.workspaces.find(({ machine }) => machine.name === "dev")!
  if (dev.machine.kind !== "vm") throw new Error("Expected a VM fixture")
  dev.machine.desktop = { startWithSandbox: true }
  const read = vi.fn(async () => fixtureDesktopState("ready"))
  const bridge = createComputerUseBridge({ ...createFixtureComputerUseBackend("ready", "ready"), readDesktopState: read })
  const page = (active: boolean) => <ComputerUseProvider bridge={bridge}><OverviewPage active={active} source={source} actions={{} as ApplicationActions} onMachinesChange={vi.fn()} selectedSandboxId={dev.machine.id} sandboxTab="overview" onOpenSandbox={vi.fn()} onCloseSandbox={vi.fn()} onSelectSandboxTab={vi.fn()} /></ComputerUseProvider>
  const view = render(page(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(read).toHaveBeenCalledOnce()
  view.rerender(page(false))
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(read).toHaveBeenCalledOnce()
  view.rerender(page(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(read).toHaveBeenCalledTimes(2)
})
