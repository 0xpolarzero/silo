import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { RemoteComputersSettings } from "@/features/application/components/remote-computers-settings"
import type { ApplicationActions } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createFixtureComputerUseBackend, fixtureDesktopState } from "@/fixtures/computer-use"
import { ComputerUseProvider, createComputerUseBridge, type ComputerUseBackend } from "./computer-use-bridge"
import { ComputerUseSection } from "./computer-use-panel"

const workspace = "silo-remote:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333"
const backend = (overrides: Partial<ComputerUseBackend> = {}): ComputerUseBackend => ({
  ...createFixtureComputerUseBackend("ready", "ready"),
  listenStatus: async () => () => {},
  ...overrides,
})
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function visibility(hidden: boolean) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(hidden ? "hidden" : "visible")
  act(() => { document.dispatchEvent(new Event("visibilitychange")) })
}
function section(b: ComputerUseBackend, active = true) {
  const bridge = createComputerUseBridge(b, { busy: 1000, idle: 1000 })
  const page = (visible: boolean) => <ComputerUseProvider bridge={bridge}><ComputerUseSection workspace={workspace} active={visible} /></ComputerUseProvider>
  const view = render(page(active))
  return { ...view, setActive: (visible: boolean) => view.rerender(page(visible)) }
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible") })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it("pauses an inactive computer-use section and refreshes once on return", async () => {
  const read = vi.fn(async () => fixtureDesktopState("ready"))
  const view = section(backend({ readDesktopState: read }), false)
  await advance(15_000)
  expect(read).not.toHaveBeenCalled()
  view.setActive(true)
  await advance(0)
  expect(read).toHaveBeenCalledOnce()
  view.setActive(false)
  await advance(15_000)
  expect(read).toHaveBeenCalledOnce()
  view.setActive(true)
  await advance(0)
  expect(read).toHaveBeenCalledTimes(2)
})

it("pauses document-hidden computer-use reads and refreshes once when visible", async () => {
  visibility(true)
  const read = vi.fn(async () => fixtureDesktopState("ready"))
  const view = section(backend({ readDesktopState: read }))
  await advance(15_000)
  expect(read).not.toHaveBeenCalled()
  visibility(false)
  await advance(0)
  expect(read).toHaveBeenCalledOnce()
  visibility(true)
  await advance(15_000)
  expect(read).toHaveBeenCalledOnce()
  view.setActive(false)
  visibility(false)
  await advance(0)
  expect(read).toHaveBeenCalledOnce()
})

it.each(["setup", "approval"] as const)("lets explicit %s finish while the section and document are hidden", async operation => {
  let finish!: (value: unknown) => void
  const work = vi.fn(() => new Promise(resolve => { finish = resolve }))
  const read = vi.fn(async () => fixtureDesktopState("ready"))
  const view = section(backend({ readDesktopState: read, ...(operation === "setup" ? { setup: work } : { setApproval: work }) }))
  await advance(0)
  fireEvent.click(screen.getByRole(operation === "setup" ? "button" : "switch", { name: operation === "setup" ? "Set up computer use" : /Allow without asking/ }))
  expect(work).toHaveBeenCalledOnce()
  view.setActive(false)
  visibility(true)
  await act(async () => { finish(fixtureDesktopState("ready")) })
  expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeEnabled()
  if (operation === "setup") expect(screen.getByRole("status")).toHaveTextContent("Reconnect agent sessions")
  await advance(15_000)
  expect(read).toHaveBeenCalledOnce()
})

it("releases remote download polling while its computer-use section is inactive", async () => {
  const read = vi.fn(async () => ({ state: "downloading", receivedBytes: 1, totalBytes: 10 }))
  const view = section(backend({ readDesktopState: async () => fixtureDesktopState("preparing"), chatGptStatus: read }))
  await advance(0)
  expect(read).toHaveBeenCalledOnce()
  view.setActive(false)
  await advance(15_000)
  expect(read).toHaveBeenCalledOnce()
  view.setActive(true)
  await advance(0)
  expect(read).toHaveBeenCalledTimes(2)
})

it("pauses remote download status polling when hidden and still settles an explicit retry", async () => {
  const read = vi.fn(async () => ({ state: "downloading", receivedBytes: 1, totalBytes: 10 }))
  let finish!: () => void
  const retry = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const store = createComputerUseBridge(backend({ chatGptStatus: read, retry }), { busy: 1000, idle: 1000 }).chatGptFor("office")
  const stop = store.subscribe(() => {})
  try {
    await advance(0)
    expect(read).toHaveBeenCalledOnce()
    visibility(true)
    await advance(15_000)
    expect(read).toHaveBeenCalledOnce()
    const pending = store.retry()
    expect(store.getSnapshot().busy).toBe(true)
    finish()
    await pending
    expect(store.getSnapshot().busy).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    visibility(false)
    await advance(0)
    expect(read).toHaveBeenCalledTimes(3)
    stop()
    visibility(true)
    visibility(false)
    await advance(15_000)
    expect(read).toHaveBeenCalledTimes(3)
  } finally { stop() }
})

it("releases remote download polling while Computers settings are inactive", async () => {
  const read = vi.fn(async (_computer?: string) => ({ state: "downloading", receivedBytes: 1, totalBytes: 10 }))
  const bridge = createComputerUseBridge(backend({ chatGptStatus: read }), { busy: 1000, idle: 1000 })
  const source = { ...applicationSourceForScenario("running"), remoteComputers: [{ id: "office", name: "Office", address: "owner@office", connected: true }] }
  const page = (active: boolean) => <ComputerUseProvider bridge={bridge}><RemoteComputersSettings source={source} actions={{} as ApplicationActions} active={active} /></ComputerUseProvider>
  const view = render(page(true))
  await advance(0)
  const reads = () => read.mock.calls.filter(([computer]) => computer === "office")
  expect(reads()).toHaveLength(1)
  view.rerender(page(false))
  await advance(15_000)
  expect(reads()).toHaveLength(1)
  view.rerender(page(true))
  await advance(0)
  expect(reads()).toHaveLength(2)
})

it("keeps one remote polling schedule when visibility returns during a read", async () => {
  let finish!: (value: unknown) => void
  const read = vi.fn(async (_computer?: string): Promise<unknown> => ({ state: "idle" }))
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const store = createComputerUseBridge(backend({ chatGptStatus: read }), { busy: 1000, idle: 1000 }).chatGptFor("office")
  const stop = store.subscribe(() => {})
  try {
    await advance(0)
    visibility(true)
    visibility(false)
    await advance(0)
    await act(async () => { finish({ state: "idle" }) })
    expect(read).toHaveBeenCalledTimes(2)
    await advance(1000)
    expect(read).toHaveBeenCalledTimes(3)
  } finally { stop() }
})
