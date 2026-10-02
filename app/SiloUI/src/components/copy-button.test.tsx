import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Terminal } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CopyButton } from "./copy-button"

const labels = { idle: "Copy command", copied: "Command copied", failed: "Copy failed" }
afterEach(() => { vi.useRealTimers() })
describe("CopyButton icons and feedback", () => {
  it.each([false, true])("keeps the latest clipboard result when an earlier request settles late (latest fails: %s)", async latestFails => {
    const user = userEvent.setup()
    let resolveFirst!: () => void
    let rejectFirst!: (error: Error) => void
    const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
    const write = vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(first)
    if (latestFails) write.mockRejectedValueOnce(new Error("Clipboard denied"))
    else write.mockResolvedValueOnce(undefined)
    render(<CopyButton value="ssh root@127.0.0.1" labels={labels} />)
    const button = screen.getByRole("button", { name: "Copy command" })
    await user.click(button)
    await user.click(button)
    const latestLabel = latestFails ? "Copy failed" : "Command copied"
    expect(screen.getByRole("button", { name: latestLabel })).toBe(button)
    await act(async () => {
      if (latestFails) resolveFirst()
      else rejectFirst(new Error("Earlier clipboard request failed"))
      await first.catch(() => {})
    })
    expect(screen.getByRole("button", { name: latestLabel })).toBe(button)
  })
  it("resolves the current text only when copying", async () => {
    const user = userEvent.setup()
    const value = vi.fn(() => "first page")
    const view = render(<CopyButton value={value} labels={labels} />)
    expect(value).not.toHaveBeenCalled()
    const latest = vi.fn(() => "older page")
    view.rerender(<CopyButton value={latest} labels={labels} />)
    expect(latest).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Copy command" }))
    expect(value).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
    expect(await navigator.clipboard.readText()).toBe("older page")
  })
  it.each([undefined, Terminal])("copies and reports success with either idle icon", async icon => {
    const user = userEvent.setup()
    render(<CopyButton icon={icon} value="ssh -p 2222 root@127.0.0.1" labels={labels} />)
    await user.click(screen.getByRole("button", { name: "Copy command" }))
    expect(await navigator.clipboard.readText()).toBe("ssh -p 2222 root@127.0.0.1")
    expect(screen.getByRole("button", { name: "Command copied" })).toHaveAttribute("data-copy-status", "copied")
  })
  it("reports clipboard failure with the terminal icon", async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard unavailable"))
    render(<CopyButton icon={Terminal} value="ssh root@127.0.0.1" labels={labels} />)
    await user.click(screen.getByRole("button", { name: "Copy command" }))
    expect(screen.getByRole("button", { name: "Copy failed" })).toHaveAttribute("data-copy-status", "failed")
  })

  it.each(["resolve", "reject"] as const)("does not schedule feedback when a clipboard write %ss after unmount", async outcome => {
    vi.useFakeTimers()
    let resolve!: () => void
    let reject!: (error: Error) => void
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise<void>((done, fail) => { resolve = done; reject = fail }))
    const view = render(<CopyButton value="command" labels={labels} />, { reactStrictMode: true })
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }))
    view.unmount()
    await act(async () => { if (outcome === "resolve") resolve(); else reject(new Error("Clipboard unavailable")) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps the newest feedback when overlapping writes finish out of order", async () => {
    vi.useFakeTimers()
    let rejectFirst!: (error: Error) => void
    let finishSecond!: () => void
    vi.spyOn(navigator.clipboard, "writeText")
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishSecond = resolve }))
    const view = render(<CopyButton value="command" labels={labels} />)
    const button = screen.getByRole("button", { name: "Copy command" })
    fireEvent.click(button)
    fireEvent.click(button)
    await act(async () => { finishSecond() })
    await act(async () => { rejectFirst(new Error("Clipboard unavailable")) })
    expect(screen.getByRole("button", { name: "Command copied" })).toHaveAttribute("data-copy-status", "copied")
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
