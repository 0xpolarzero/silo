import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Button } from "@/components/ui/button"
import { SetupNotice } from "@/features/onboarding/components/setup-notice"
import { fixtureMachineDefaults } from "@/fixtures/machine-configurations"
import type { ReviewQueueItemView, WorkspaceProgressView } from "@/features/onboarding/model/onboarding-state"
import { ReviewStep } from "@/features/onboarding/steps/review-step"
import { WorkspacesStep } from "@/features/onboarding/steps/workspaces-step"

const progress: WorkspaceProgressView = {
  status: "running", elapsedSeconds: 83, currentWorkspace: "playgrounds", currentMessage: "Checking sandbox connectivity",
  completedOperations: 4, totalOperations: 9, fraction: 4 / 9,
  workspaces: [
    { name: "dev", status: "ready", detail: "Ready" },
    { name: "playgrounds", status: "working", detail: "Checking sandbox connectivity" },
    { name: "personal", status: "waiting", detail: "Waiting" },
  ],
  visibleEvents: [], readyCount: 1, workingCount: 1, waitingCount: 1, failedCount: 0, retryable: false,
}

const queueItems: ReviewQueueItemView[] = [
  { id: "workspaceRun", label: "Create sandboxes", status: "succeeded" },
  { id: "workspaceVerify", label: "Verify sandboxes", status: "running" },
  { id: "githubRun", label: "Save GitHub", status: "queued" },
  { id: "githubVerify", label: "Verify GitHub", status: "queued" },
  { id: "identityRun", label: "Save Git identities", status: "queued" },
  { id: "identityVerify", label: "Verify Git identities", status: "queued" },
  { id: "completion", label: "Finish setup", status: "queued" },
]

function renderReview(onEditStep = vi.fn()) {
  render(<ReviewStep machines={fixtureMachineDefaults} queueItems={queueItems} workspaces={progress.workspaces} workspaceRetryable={false} identitySummary="Alex · alex@example.com" githubSummary="2 repositories selected" onRetryWorkspaceSetup={vi.fn()} onEditStep={onEditStep} />)
  return onEditStep
}

describe("setup progress and review presentation", () => {
  it("keeps activity collapsed until requested and preserves the list while opening it", async () => {
    const user = userEvent.setup()
    render(<WorkspacesStep machines={fixtureMachineDefaults} progress={progress} onMachinesChange={vi.fn()} onRetry={vi.fn()} />)
    const machines = screen.getByRole("list", { name: "Configured sandboxes" })
    expect(screen.queryByLabelText("Sandbox activity")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Expand activity" }))
    expect(screen.getByLabelText("Sandbox activity")).toHaveTextContent("No activity yet.")
    expect(screen.getByRole("list", { name: "Configured sandboxes" })).toBe(machines)
    expect(within(machines).getAllByRole("listitem")).toHaveLength(3)
    await user.click(screen.getByRole("button", { name: "Collapse activity" }))
    expect(screen.queryByLabelText("Sandbox activity")).not.toBeInTheDocument()
  })

  it("distinguishes each sandbox status without replacing the busy machine icon", () => {
    render(<WorkspacesStep machines={fixtureMachineDefaults} progress={progress} onMachinesChange={vi.fn()} onRetry={vi.fn()} />)
    const rows = within(screen.getByRole("list", { name: "Configured sandboxes" })).getAllByRole("listitem")
    expect(within(rows[0]).getByText("Complete")).toBeVisible()
    expect(within(rows[1]).getByText("In progress")).toBeVisible()
    expect(rows[1]).toHaveAttribute("aria-busy", "true")
    expect(rows[1].querySelector("svg.lucide-monitor")).not.toBeNull()
    expect(rows[1].querySelector("svg.lucide-loader-circle")).not.toBeNull()
    expect(within(rows[2]).getByText("Waiting")).toBeVisible()
    expect(screen.getByLabelText("Elapsed time")).toHaveTextContent("01:23")
  })

  it("keeps recovery and retry beside the failed operation", async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    render(<WorkspacesStep machines={fixtureMachineDefaults} progress={{ ...progress, status: "failed", retryable: true, currentMessage: "The sandbox could not be reached.", recovery: "Check the network connection, then retry setup.", workspaces: [{ name: "playgrounds", status: "failed", detail: "The sandbox could not be reached." }] }} onMachinesChange={vi.fn()} onRetry={retry} />)
    const status = screen.getByRole("alert")
    expect(status).toHaveTextContent("The sandbox could not be reached.")
    expect(status.parentElement).toHaveTextContent("Check the network connection, then retry setup.")
    await user.click(within(status).getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledOnce()
    expect(within(screen.getByRole("list", { name: "Configured sandboxes" })).getByText("Failed")).toBeVisible()
  })

  it("shows validation on existing cards and preserves sandbox order and resources", () => {
    renderReview()
    expect(screen.queryByRole("list", { name: "Setup operations" })).not.toBeInTheDocument()
    expect(screen.queryByText("queued")).not.toBeInTheDocument()
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument()
    const sandboxes = within(screen.getByRole("list", { name: "Sandboxes" })).getAllByRole("listitem")
    expect(sandboxes.map((row) => row.querySelector("[title]")?.getAttribute("title"))).toEqual(["dev", "playgrounds", "personal"])
    expect(sandboxes[0]).toHaveTextContent("Complete")
    expect(sandboxes[1]).toHaveTextContent("In progress")
    expect(sandboxes[1]).toHaveAttribute("aria-busy", "true")
    expect(sandboxes[2]).toHaveTextContent("Waiting")
    expect(sandboxes[0]).toHaveTextContent("8 CPU · 32 GB RAM · 120 GB workspace")
    expect(screen.getByText("2 repositories selected")).toBeVisible()
    expect(screen.getByText("Alex · alex@example.com")).toBeVisible()
  })

  it.each([
    ["idle", "Not started"],
    ["queued", "Waiting"],
    ["running", "In progress"],
    ["succeeded", "Complete"],
    ["failed", "Failed"],
  ] as const)("shows %s Git validation on the author card", (status, label) => {
    render(<ReviewStep machines={fixtureMachineDefaults} workspaces={progress.workspaces} queueItems={[
      { id: "githubRun", label: "Save GitHub", status: "succeeded" },
      { id: "githubVerify", label: "Verify GitHub", status },
      { id: "identityRun", label: "Save Git identities", status: "succeeded" },
      { id: "identityVerify", label: "Verify Git identities", status, failure: status === "failed" ? "Git identity could not be verified." : undefined },
    ]} workspaceRetryable={false} identitySummary="Alex · alex@example.com" githubSummary="GitHub not connected" onRetryWorkspaceSetup={vi.fn()} />)
    const author = screen.getByRole("group", { name: "Git author" })
    expect(author).toHaveTextContent(label)
    expect(author).toHaveTextContent("Alex · alex@example.com")
    for (const row of [author, screen.getByRole("group", { name: "GitHub access" })]) {
      expect(row.classList.contains("bg-emerald-500/[0.035]")).toBe(status === "succeeded")
    }
    if (status === "failed") expect(author).toHaveTextContent("Git identity could not be verified.")
  })

  it("keeps sandbox failures on the affected sandbox and never validates missing results", () => {
    render(<ReviewStep machines={fixtureMachineDefaults} workspaces={[
      { name: "dev", status: "failed", detail: "Sandbox could not be verified." },
    ]} queueItems={[]} workspaceRetryable={false} identitySummary="No Git author" githubSummary="GitHub not connected" onRetryWorkspaceSetup={vi.fn()} />)
    const sandboxes = within(screen.getByRole("list", { name: "Sandboxes" })).getAllByRole("listitem")
    expect(sandboxes[0]).toHaveTextContent("Failed")
    expect(sandboxes[0]).toHaveTextContent("Sandbox could not be verified.")
    expect(sandboxes[1]).not.toHaveTextContent("Complete")
    expect(screen.queryByText("Complete")).not.toBeInTheDocument()
  })

  it("routes review edit shortcuts to their corresponding steps", async () => {
    const user = userEvent.setup()
    const edit = renderReview()
    await user.click(screen.getByRole("button", { name: "Edit sandboxes" }))
    expect(edit).toHaveBeenLastCalledWith("workspaces")
    await user.click(screen.getByRole("button", { name: "Edit GitHub and Git identity" }))
    expect(edit).toHaveBeenLastCalledWith("github")
    expect(screen.queryByRole("button", { name: "Edit GitHub access" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit Git author" })).not.toBeInTheDocument()
  })

  it("keeps recovery visible while technical evidence stays optional", async () => {
    const user = userEvent.setup()
    const repair = vi.fn()
    render(<SetupNotice title="Setup couldn’t finish" detail="The helper is unavailable." recovery="Repair the installation to continue." technicalDetails="Helper connection timed out after 30 seconds." action={<Button onClick={repair}>Repair</Button>} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Repair the installation to continue.")
    expect(screen.queryByText("Helper connection timed out after 30 seconds.")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show technical details" }))
    expect(screen.getByText("Helper connection timed out after 30 seconds.")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Repair" }))
    expect(repair).toHaveBeenCalledOnce()
  })
})
