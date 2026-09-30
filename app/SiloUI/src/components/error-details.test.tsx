import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ErrorDetails } from "./error-details"
import { splitErrorDetails } from "@/lib/error-details"

const stderr = Array.from({ length: 40 }, (_, index) => `krun: step ${index} failed at 0x${index.toString(16)}`).join("\n")

describe("splitErrorDetails", () => {
  it("keeps a short message whole, with no details", () => {
    expect(splitErrorDetails("Stop sandbox 'dev' before removing it.")).toEqual({ summary: "Stop sandbox 'dev' before removing it.", details: null })
    expect(splitErrorDetails("Start failed: libkrunfw could not load\nThe library signature was rejected.")).toEqual({
      summary: "Start failed: libkrunfw could not load\nThe library signature was rejected.", details: null,
    })
  })

  it("uses a separate diagnostic when the backend supplies one", () => {
    expect(splitErrorDetails("Could not start dev. Restart Silo and try again.", "exit code 1: boom")).toEqual({
      summary: "Could not start dev. Restart Silo and try again.", details: "exit code 1: boom",
    })
  })

  it("moves exit codes and command output into the details", () => {
    expect(splitErrorDetails("Sandbox setup failed (exit code 3): mount: permission denied")).toEqual({
      summary: "Sandbox setup failed.", details: "Sandbox setup failed (exit code 3): mount: permission denied",
    })
    expect(splitErrorDetails("exit code 1: error: unable to open /dev/kvm")).toEqual({ summary: null, details: "exit code 1: error: unable to open /dev/kvm" })
  })

  it("summarizes long output by its first line and keeps all of it in the details", () => {
    const message = `Start failed: the VM did not boot\n${stderr}\n[Diagnostic truncated]`
    expect(splitErrorDetails(message)).toEqual({ summary: "Start failed: the VM did not boot", details: message })
  })

  it("shortens a single very long line at a sentence or word boundary", () => {
    const message = `The runtime reported a failure. ${"x".repeat(20)} ${"detail ".repeat(60)}`.trim()
    const { summary, details } = splitErrorDetails(message)
    expect(summary).toBe("The runtime reported a failure.")
    expect(details).toBe(message)
    const words = `Runtime ${"word ".repeat(80)}`.trim()
    expect(splitErrorDetails(words).summary).toMatch(/^Runtime word( word)*…$/)
    expect(splitErrorDetails(words).summary!.length).toBeLessThanOrEqual(161)
  })
})

describe("ErrorDetails", () => {
  it("shows a one-line summary with the full output behind Details and Copy", async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    const message = `Start failed: the VM did not boot\n${stderr}`
    render(<ErrorDetails message={message} />)
    expect(screen.getByText("Start failed: the VM did not boot")).toBeVisible()
    expect(screen.queryByText(/krun: step 39/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show details" }))
    expect(screen.getByText(/krun: step 39/)).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Copy details" }))
    expect(writeText).toHaveBeenCalledWith(message)
  })

  it("renders a short message as plain text", () => {
    render(<ErrorDetails message="Stop sandbox 'dev' before removing it." />)
    expect(screen.getByText("Stop sandbox 'dev' before removing it.")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Show details" })).not.toBeInTheDocument()
  })

  it("falls back to the caller's summary when the message is only command output", () => {
    render(<ErrorDetails message="exit code 1: error: unable to open /dev/kvm" fallbackSummary="Sandbox changes failed." />)
    expect(screen.getByText("Sandbox changes failed.")).toBeVisible()
    expect(screen.queryByText(/exit code/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show details" })).toBeVisible()
  })
})
