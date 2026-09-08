import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { SiloProgressEvent } from "@/contracts/silo"
import { ActivityOutput } from "@/features/onboarding/components/activity-output"

function event(overrides: Partial<SiloProgressEvent> = {}): SiloProgressEvent {
  return { schemaVersion: 1, type: "progress", requestId: "first", phase: "workspaces", workspace: "dev", message: "Preparing disks", safeForDisplay: true, ...overrides }
}

async function show(events: SiloProgressEvent[], error?: string) {
  const user = userEvent.setup()
  render(<ActivityOutput events={events} error={error} />)
  await user.click(screen.getByRole("button", { name: "Expand activity" }))
  return { user, output: screen.getByLabelText("Sandbox activity") }
}

describe("live setup activity", () => {
  it("separates attempts and shows historical timestamps, warnings, and errors", async () => {
    const timestamp = new Date("2026-09-08T09:15:00Z").getTime()
    const { output } = await show([
      event({ timestamp, level: "warning", message: "Image download is still running" }),
      event({ timestamp: timestamp + 10_000, level: "error", message: "Download timed out. Retry setup." }),
      event({ requestId: "retry", timestamp: timestamp + 20_000, message: "Retrying image download" }),
    ])
    expect(output.textContent).toContain(`Attempt 1\n${new Date(timestamp).toLocaleString()}  ·  Warning  ·  dev  ·  Image download is still running`)
    expect(output.textContent).toContain("Error  ·  dev  ·  Download timed out. Retry setup.")
    expect(output.textContent).toContain("\n\nAttempt 2\n")
    expect(output.textContent).toContain(new Date(timestamp + 20_000).toLocaleString())
  })

  it("copies exactly the visible diagnostics and excludes unsafe events", async () => {
    const { user, output } = await show([
      event({ safeForDisplay: false, requestId: "private", message: "secret credential" }),
      event({ message: "Verification completed" }),
    ])
    const write = vi.spyOn(navigator.clipboard, "writeText")
    await user.click(screen.getByRole("button", { name: "Copy activity" }))
    expect(write).toHaveBeenCalledWith(output.textContent)
    expect(output.textContent).toBe("Attempt 1\ndev  ·  Verification completed")
    expect(output.textContent).not.toContain("secret")
  })

  it("shows known download bytes and elapsed time without inventing a total or percentage", async () => {
    const { output } = await show([
      event({ message: "Downloading image", downloadedBytes: 2 * 1024 * 1024, elapsedSeconds: 12.9 }),
      event({ message: "Downloading image", downloadedBytes: 3 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 }),
    ])
    const lines = output.textContent!.split("\n")
    expect(lines[1]).toBe("dev  ·  Downloading image  ·  2 MiB downloaded  ·  12s elapsed")
    expect(lines[2]).toBe("dev  ·  Downloading image  ·  3 MiB / 4 MiB downloaded")
    expect(output.textContent).not.toContain("%")
  })

  it("keeps a history read failure visible alongside new activity", async () => {
    const error = "Saved setup activity could not be loaded. Retry by reopening Silo."
    const { output } = await show([event()], error)
    expect(output.textContent).toBe(`${error}\n\nAttempt 1\ndev  ·  Preparing disks`)
  })
})
