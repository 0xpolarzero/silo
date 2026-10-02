import { useRef } from "react"
import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useStatusPanelSize } from "./use-status-panel-size"

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
let height = 120
let measure: () => void
let systemReduceMotion = false

function Panel({ reduced = false }: { reduced?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useStatusPanelSize(ref)
  return <div ref={ref} data-reduce-motion={reduced}><div>Page</div></div>
}

beforeEach(() => {
  vi.useFakeTimers()
  height = 120
  systemReduceMotion = false
  native.invoke.mockReset().mockResolvedValue(undefined)
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ height }) as DOMRect)
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { measure = callback }
    observe() {} disconnect() {}
  })
  vi.stubGlobal("matchMedia", () => ({ get matches() { return systemReduceMotion }, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("releases its fixed height after native failure and retries on the next measurement", async () => {
  const failure = new Error("Window unavailable")
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  native.invoke.mockRejectedValueOnce(failure)
  const view = render(<Panel />)
  await act(async () => {})
  expect(log).toHaveBeenCalledExactlyOnceWith("Silo status resize:", failure)
  expect((view.container.firstElementChild as HTMLElement).style.height).toBe("")

  height = 240
  await act(async () => { measure() })
  expect(native.invoke).toHaveBeenLastCalledWith("resize_status", { height: 240 })
  expect(native.invoke).toHaveBeenCalledTimes(2)
  expect(view.container.firstElementChild).toHaveStyle({ height: "240px" })
  expect(vi.getTimerCount()).toBe(0)
})

it("does not apply a pending native acknowledgment after unmount", async () => {
  let acknowledge!: () => void
  native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve }))
  const view = render(<Panel />)
  const panel = view.container.firstElementChild as HTMLElement
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("resize_status", { height: 120 })
  view.unmount()
  await act(async () => { acknowledge(); await vi.runAllTimersAsync() })
  expect(panel.style.height).toBe("")
  expect(native.invoke).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("cancels the next animation frame before it can resize an unmounted panel", async () => {
  const view = render(<Panel />)
  await act(async () => {})
  native.invoke.mockClear()
  height = 300
  act(() => { measure() })
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  await act(async () => { await vi.runAllTimersAsync() })
  expect(native.invoke).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("starts compact, grows and shrinks through acknowledged frames, and caps long pages", async () => {
  const view = render(<Panel />)
  await act(async () => {})
  expect(view.container.firstElementChild).toHaveStyle({ height: "120px" })
  native.invoke.mockClear()
  height = 300
  await act(async () => { measure(); await vi.runAllTimersAsync() })
  const growth = native.invoke.mock.calls.map(([, args]) => args.height)
  expect(growth.length).toBeGreaterThan(1)
  expect(growth).toEqual([...growth].sort((a, b) => a - b))
  expect(growth.at(-1)).toBe(300)
  expect(view.container.firstElementChild).toHaveStyle({ height: "300px" })
  native.invoke.mockClear()
  height = 120
  await act(async () => { measure(); await vi.runAllTimersAsync() })
  const shrink = native.invoke.mock.calls.map(([, args]) => args.height)
  expect(shrink).toEqual([...shrink].sort((a, b) => b - a))
  expect(view.container.firstElementChild).toHaveStyle({ height: "120px" })
  height = 900
  await act(async () => { measure(); await vi.runAllTimersAsync() })
  expect(view.container.firstElementChild).toHaveStyle({ height: "520px" })
})

it("serializes slow native requests and converges on the latest page height", async () => {
  const view = render(<Panel />)
  await act(async () => {})
  let acknowledge!: () => void
  native.invoke.mockClear().mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve }))
  height = 300
  await act(async () => { measure(); await vi.advanceTimersByTimeAsync(32) })
  expect(native.invoke).toHaveBeenCalledTimes(1)
  expect(view.container.firstElementChild).toHaveStyle({ height: "120px" })
  height = 180
  await act(async () => { measure(); await vi.advanceTimersByTimeAsync(100) })
  expect(native.invoke).toHaveBeenCalledTimes(1)
  await act(async () => { acknowledge(); await vi.runAllTimersAsync() })
  expect(view.container.firstElementChild).toHaveStyle({ height: "180px" })
})

it.each(["app", "system"])("resizes directly with %s Reduce Motion", async (setting) => {
  systemReduceMotion = setting === "system"
  const view = render(<Panel reduced={setting === "app"} />)
  await act(async () => {})
  native.invoke.mockClear()
  height = 300
  await act(async () => { measure() })
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("resize_status", { height: 300 })
  expect(view.container.firstElementChild).toHaveStyle({ height: "300px" })
})
